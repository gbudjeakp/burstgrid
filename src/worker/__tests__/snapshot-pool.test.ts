import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SnapshotPool } from '../snapshot-pool.js';
import type { SnapshotPaths } from '../firecracker.js';

// ─── Mock FirecrackerVM ───────────────────────────────────────────────────────

const { mockBoot, mockCreateSnapshot, mockShutdown } = vi.hoisted(() => ({
  mockBoot: vi.fn().mockResolvedValue(undefined),
  mockCreateSnapshot: vi.fn().mockResolvedValue(undefined),
  mockShutdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../firecracker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../firecracker.js')>();
  return {
    ...actual,
    FirecrackerVM: vi.fn().mockImplementation(function () {
      return {
        boot: mockBoot,
        createSnapshot: mockCreateSnapshot,
        shutdown: mockShutdown,
      };
    }),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePool(size = 2) {
  return new SnapshotPool({
    poolSize: size,
    snapshotDir: '/tmp/test-snaps',
    vmBase: {
      vmId: 'base',
      kernelPath: '/kernel',
      rootfsPath: '/rootfs.img',
      memoryMiB: 2_048,
      vcpus: 2,
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SnapshotPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warmUp() boots poolSize VMs and creates a snapshot for each', async () => {
    const pool = makePool(2);
    await pool.warmUp();

    expect(mockBoot).toHaveBeenCalledTimes(2);
    expect(mockCreateSnapshot).toHaveBeenCalledTimes(2);
    expect(mockShutdown).toHaveBeenCalledTimes(2);
  });

  it('acquire() returns a snapshot path after warmUp', async () => {
    const pool = makePool(2);
    await pool.warmUp();

    const paths = await pool.acquire();

    expect(paths).toMatchObject({
      snapshotPath: expect.stringContaining('.snap'),
      memFilePath: expect.stringContaining('.mem'),
    });
  });

  it('acquire() returns distinct paths for concurrent acquisitions', async () => {
    const pool = makePool(3);
    await pool.warmUp();

    const [p1, p2] = await Promise.all([pool.acquire(), pool.acquire()]);

    expect(p1.snapshotPath).not.toBe(p2.snapshotPath);
  });

  it('acquire() cold-boots a new snapshot when pool is empty', async () => {
    const pool = makePool(1);
    await pool.warmUp();

    await pool.acquire(); // drains the pool
    mockBoot.mockClear();
    mockCreateSnapshot.mockClear();

    // Next acquire should cold-boot a new VM
    const paths = await pool.acquire();

    expect(mockBoot).toHaveBeenCalledTimes(1);
    expect(mockCreateSnapshot).toHaveBeenCalledTimes(1);
    expect(paths).toMatchObject({ snapshotPath: expect.any(String), memFilePath: expect.any(String) });
  });

  it('warmUp() with poolSize=0 creates no snapshots', async () => {
    const pool = makePool(0);
    await pool.warmUp();

    expect(mockBoot).not.toHaveBeenCalled();
  });
});

describe('SnapshotPool — snapshot path format', () => {
  it('snapshot files are placed in the configured snapshotDir', async () => {
    const pool = new SnapshotPool({
      poolSize: 1,
      snapshotDir: '/custom/snap-dir',
      vmBase: { vmId: 'x', kernelPath: '/k', rootfsPath: '/r.img', memoryMiB: 1_024, vcpus: 1 },
    });
    await pool.warmUp();

    const call = mockCreateSnapshot.mock.calls[0][0] as SnapshotPaths;
    expect(call.snapshotPath).toMatch(/^\/custom\/snap-dir\//);
    expect(call.memFilePath).toMatch(/^\/custom\/snap-dir\//);
  });
});
