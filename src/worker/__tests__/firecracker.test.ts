import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FirecrackerVM, type VMConfig } from '../firecracker.js';

// ─── Mock child_process so no real firecracker binary is needed ───────────────

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    on: vi.fn(),
    kill: vi.fn(),
    pid: 99999,
  })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

/** Start a mock Firecracker API server on a Unix socket. Returns recorded requests + stop fn. */
async function startMockApiServer(sockPath: string): Promise<{
  requests: RecordedRequest[];
  stop: () => void;
}> {
  const requests: RecordedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        body: body ? JSON.parse(body) : undefined,
      });
      res.writeHead(204).end();
    });
  });

  await new Promise<void>(resolve => server.listen(sockPath, resolve));
  return { requests, stop: () => server.close() };
}

/** Returns the socket path FirecrackerVM will use for the given vmId. */
function vmSockPath(vmId: string): string {
  return path.join(os.tmpdir(), 'burstgrid', vmId, 'firecracker.sock');
}

const BASE_CFG: VMConfig = {
  vmId: 'test-vm',
  kernelPath: '/kernel',
  rootfsPath: '/rootfs.img',
  memoryMiB: 2_048,
  vcpus: 2,
  runnerToken: 'tok',
  runnerLabels: 'linux',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FirecrackerVM — boot-arg mode (default)', () => {
  const VM_ID = 'test-vm-boot';
  let sockDir: string;
  let api: { requests: RecordedRequest[]; stop: () => void };

  beforeEach(async () => {
    sockDir = path.join(os.tmpdir(), 'burstgrid', VM_ID);
    await fs.mkdir(sockDir, { recursive: true });
    api = await startMockApiServer(vmSockPath(VM_ID));
  });

  afterEach(async () => {
    api.stop();
    await fs.rm(sockDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('configure() sends boot-source with token in boot_args', async () => {
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: VM_ID });
    await (vm as unknown as { configure(): Promise<void> }).configure();

    const bootSource = api.requests.find(r => r.path === '/boot-source');
    expect(bootSource).toBeDefined();
    expect((bootSource!.body as { boot_args: string }).boot_args).toContain('RUNNER_TOKEN=tok');
    expect((bootSource!.body as { boot_args: string }).boot_args).toContain('RUNNER_LABELS=linux');
  });

  it('configure() injects REGISTRY_MIRROR when registryMirror is set', async () => {
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: VM_ID, registryMirror: 'http://mirror.internal' });
    await (vm as unknown as { configure(): Promise<void> }).configure();

    const bootSource = api.requests.find(r => r.path === '/boot-source');
    expect((bootSource!.body as { boot_args: string }).boot_args).toContain('REGISTRY_MIRROR=http://mirror.internal');
  });

  it('configure() injects ACTIONS_CACHE_URL when cacheServerUrl is set', async () => {
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: VM_ID, cacheServerUrl: 'http://127.0.0.1:4321/', workerToken: 'wt' });
    await (vm as unknown as { configure(): Promise<void> }).configure();

    const bootArgs = (api.requests.find(r => r.path === '/boot-source')!.body as { boot_args: string }).boot_args;
    expect(bootArgs).toContain('ACTIONS_CACHE_URL=http://127.0.0.1:4321/');
    expect(bootArgs).toContain('ACTIONS_RUNTIME_TOKEN=wt');
  });
});

describe('FirecrackerVM — MMDS mode', () => {
  const VM_ID = 'test-vm-mmds';
  let sockDir: string;
  let api: { requests: RecordedRequest[]; stop: () => void };

  beforeEach(async () => {
    sockDir = path.join(os.tmpdir(), 'burstgrid', VM_ID);
    await fs.mkdir(sockDir, { recursive: true });
    api = await startMockApiServer(vmSockPath(VM_ID));
  });

  afterEach(async () => {
    api.stop();
    await fs.rm(sockDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('configure() in MMDS mode omits token from boot_args and configures MMDS device', async () => {
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: VM_ID, mmdsMode: true });
    await (vm as unknown as { configure(): Promise<void> }).configure();

    const bootSource = api.requests.find(r => r.path === '/boot-source');
    const bootArgs = (bootSource!.body as { boot_args: string }).boot_args;

    expect(bootArgs).not.toContain('RUNNER_TOKEN=');
    expect(bootArgs).toContain('MMDS_MODE=1');

    const mmdsConfig = api.requests.find(r => r.path === '/mmds/config');
    expect(mmdsConfig).toBeDefined();

    const mmdsPut = api.requests.find(r => r.path === '/mmds' && r.method === 'PUT');
    expect(mmdsPut).toBeDefined();
    expect((mmdsPut!.body as { latest: { 'meta-data': { 'runner-token': string } } }).latest['meta-data']['runner-token']).toBe('');
  });

  it('injectMmdsToken() sends PATCH /mmds with token and labels', async () => {
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: VM_ID, mmdsMode: true });
    await vm.injectMmdsToken('secret-token', 'linux,x64');

    const patch = api.requests.find(r => r.path === '/mmds' && r.method === 'PATCH');
    expect(patch).toBeDefined();
    const meta = (patch!.body as { latest: { 'meta-data': { 'runner-token': string; 'runner-labels': string } } }).latest['meta-data'];
    expect(meta['runner-token']).toBe('secret-token');
    expect(meta['runner-labels']).toBe('linux,x64');
  });
});

describe('FirecrackerVM — snapshot API', () => {
  const VM_ID = 'test-vm-snap';
  let sockDir: string;
  let api: { requests: RecordedRequest[]; stop: () => void };

  beforeEach(async () => {
    sockDir = path.join(os.tmpdir(), 'burstgrid', VM_ID);
    await fs.mkdir(sockDir, { recursive: true });
    api = await startMockApiServer(vmSockPath(VM_ID));
  });

  afterEach(async () => {
    api.stop();
    await fs.rm(sockDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('createSnapshot() sends PUT /snapshot/create with Full type', async () => {
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: VM_ID });
    await vm.createSnapshot({ snapshotPath: path.join(sockDir, 'vm.snap'), memFilePath: path.join(sockDir, 'vm.mem') });

    const snapReq = api.requests.find(r => r.path === '/snapshot/create');
    expect(snapReq).toBeDefined();
    expect((snapReq!.body as { snapshot_type: string }).snapshot_type).toBe('Full');
    expect((snapReq!.body as { snapshot_path: string }).snapshot_path).toContain('vm.snap');
  });
});
