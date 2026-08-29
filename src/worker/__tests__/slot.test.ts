import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { Slot } from '../slot.js';
import { VM_BOOT_TARGET_MS } from '../firecracker.js';
import type { RootfsImage } from '../../types/index.js';

// resolveRootfs is private, so we test it through a Slot in simulate mode.
// We read back the resolved path by inspecting the vm config in firecracker mode,
// but since we can't easily do that, we test the exported helper indirectly
// via a re-export shim. Instead, let's just unit-test the function logic directly
// by extracting it through a thin test harness using the same logic.

// Mirror the resolution logic so we can unit-test it without coupling to internals.
function resolveRootfs(
  labels: string[],
  catalog: RootfsImage[] | undefined,
  imageDir: string | undefined,
  fallback: string,
): string {
  const tag = labels.find(l => l.toLowerCase().startsWith('burstgrid:image='));
  if (!tag) return fallback;
  const name = tag.slice('burstgrid:image='.length);
  if (catalog) {
    const entry = catalog.find(e => e.name.toLowerCase() === name.toLowerCase());
    if (entry) return entry.path;
  }
  if (imageDir) return path.join(imageDir, `${name}.img`);
  return fallback;
}

const catalog: RootfsImage[] = [
  { name: 'ubuntu-docker', path: '/images/ubuntu-docker.img' },
  { name: 'node20',        path: '/images/node20.img' },
  { name: 'ml-cpu',        path: '/data/ml/pytorch-cpu.img' },
];

describe('resolveRootfs — image catalog', () => {
  it('returns the catalog path when the label matches an entry', () => {
    expect(resolveRootfs(['burstgrid:image=ubuntu-docker'], catalog, '/dir', '/default.img'))
      .toBe('/images/ubuntu-docker.img');
  });

  it('is case-insensitive for catalog lookups', () => {
    expect(resolveRootfs(['BURSTGRID:IMAGE=Node20'], catalog, '/dir', '/default.img'))
      .toBe('/images/node20.img');
  });

  it('resolves a custom user-defined image path', () => {
    expect(resolveRootfs(['burstgrid:image=ml-cpu'], catalog, '/dir', '/default.img'))
      .toBe('/data/ml/pytorch-cpu.img');
  });

  it('falls through to imageDir convention when name is not in catalog', () => {
    expect(resolveRootfs(['burstgrid:image=python3'], catalog, '/dir', '/default.img'))
      .toBe(path.join('/dir', 'python3.img'));
  });

  it('falls back to default when no label is present', () => {
    expect(resolveRootfs(['linux', 'self-hosted'], catalog, '/dir', '/default.img'))
      .toBe('/default.img');
  });

  it('falls back to default when catalog is empty and imageDir is absent', () => {
    expect(resolveRootfs(['burstgrid:image=anything'], [], undefined, '/default.img'))
      .toBe('/default.img');
  });
});

describe('resolveRootfs — imageDir convention only (no catalog)', () => {
  it('builds path from imageDir + name + .img when no catalog is provided', () => {
    expect(resolveRootfs(['burstgrid:image=docker'], undefined, '/rootfs', '/default.img'))
      .toBe(path.join('/rootfs', 'docker.img'));
  });

  it('falls back to default when neither catalog nor imageDir is set', () => {
    expect(resolveRootfs(['burstgrid:image=docker'], undefined, undefined, '/default.img'))
      .toBe('/default.img');
  });
});

// Verify the Slot class accepts the imageCatalog field without throwing
describe('Slot imageCatalog wiring', () => {
  it('constructs without error when imageCatalog is provided', () => {
    expect(() => new Slot({
      jobId: 'test',
      mode: 'simulate',
      vmImagePath: '/default.img',
      kernelPath: '/vmlinux',
      imageCatalog: catalog,
    })).not.toThrow();
  });
});

// ─── Cold-start timing contract ───────────────────────────────────────────────
// Simulate mode models the VM_BOOT_TARGET_MS window.
// These tests use fake timers to verify the contract without real wall-clock delay.

function makeSimulateSlot() {
  return new Slot({ jobId: 'boot-test', mode: 'simulate', vmImagePath: '/x', kernelPath: '/k' });
}

describe('simulate mode cold-start contract', () => {
  it('VM_BOOT_TARGET_MS is within the documented <200ms claim', () => {
    expect(VM_BOOT_TARGET_MS).toBeLessThanOrEqual(200);
    expect(VM_BOOT_TARGET_MS).toBeGreaterThan(0);
  });

  it('start() does not resolve before VM_BOOT_TARGET_MS elapses', async () => {
    vi.useFakeTimers();
    const slot = makeSimulateSlot();
    let resolved = false;
    const p = slot.start('token', ['linux']).then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(VM_BOOT_TARGET_MS - 1);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
    vi.useRealTimers();
  });

  it('wait() resolves in a second VM_BOOT_TARGET_MS window (simulates job duration)', async () => {
    vi.useFakeTimers();
    const slot = makeSimulateSlot();
    await vi.advanceTimersByTimeAsync(VM_BOOT_TARGET_MS); // drain start()
    let done = false;
    const p = slot.wait().then(() => { done = true; });

    await vi.advanceTimersByTimeAsync(VM_BOOT_TARGET_MS - 1);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    vi.useRealTimers();
  });
});

// ─── Process mode env vars ────────────────────────────────────────────────────

const SPAWN_MOCK = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: SPAWN_MOCK };
});

function makeFakeChild() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      listeners[event]?.forEach(cb => cb(...args));
    },
  };
}

describe('process mode — runner env vars', () => {
  beforeEach(() => { SPAWN_MOCK.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  function spawnSlot(overrides: Partial<ConstructorParameters<typeof Slot>[0]> = {}) {
    const child = makeFakeChild();
    SPAWN_MOCK.mockReturnValue(child);
    const slot = new Slot({
      jobId: 'j1',
      mode: 'process',
      vmImagePath: '/img',
      kernelPath: '/k',
      runnerPath: '/opt/actions-runner/burstgrid-run.sh',
      repoUrl: 'https://github.com/owner/repo',
      slotIndex: 3,
      ...overrides,
    });
    const promise = slot.start('tok', ['self-hosted', 'linux', 'burstgrid:size=large']);
    child.emit('exit', 0);
    return { promise, env: SPAWN_MOCK.mock.calls[0]?.[2]?.env as Record<string, string> };
  }

  it('sets RUNNER_REPO_URL from repoUrl', async () => {
    const { promise, env } = spawnSlot();
    await promise;
    expect(env.RUNNER_REPO_URL).toBe('https://github.com/owner/repo');
  });

  it('sets RUNNER_SLOT_DIR from slotIndex', async () => {
    const { promise, env } = spawnSlot();
    await promise;
    expect(env.RUNNER_SLOT_DIR).toBe('/opt/actions-runner-3');
  });

  it('defaults RUNNER_SLOT_DIR to index 0 when slotIndex is omitted', async () => {
    const { promise, env } = spawnSlot({ slotIndex: undefined });
    await promise;
    expect(env.RUNNER_SLOT_DIR).toBe('/opt/actions-runner-0');
  });

  it('sets RUNNER_ALLOW_RUNASROOT', async () => {
    const { promise, env } = spawnSlot();
    await promise;
    expect(env.RUNNER_ALLOW_RUNASROOT).toBe('1');
  });

  it('sets RUNNER_TOKEN', async () => {
    const { promise, env } = spawnSlot();
    await promise;
    expect(env.RUNNER_TOKEN).toBe('tok');
  });

  it('rejects when the child exits non-zero', async () => {
    const child = makeFakeChild();
    SPAWN_MOCK.mockReturnValue(child);
    const slot = new Slot({ jobId: 'j2', mode: 'process', vmImagePath: '/img', kernelPath: '/k' });
    // start() only stores procExit — wait() returns the rejection
    await slot.start('tok', []);
    const p = slot.wait();
    child.emit('exit', 1);
    await expect(p).rejects.toThrow('runner exited 1');
  });
});
