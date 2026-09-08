import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FirecrackerVM, type VMConfig } from '../firecracker.js';

// ─── Mock child_process so no real firecracker binary is needed ───────────────

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    on: vi.fn(),
    kill: vi.fn(),
    pid: 99999,
  })),
  spawnSync: vi.fn(() => ({ status: 0, stderr: Buffer.from('') })),
}));

vi.mock('../../telemetry/index.js', () => ({
  recordVmBootDuration: vi.fn(),
  recordVmResourceUsage: vi.fn(),
  logVmLine: vi.fn(),
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

  it("configure() base64-encodes the SSH public key in boot_args so spaces in the key survive the cmdline's space-delimited tokenizing", async () => {
    const pubkey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com';
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: VM_ID, sshPublicKey: pubkey });
    await (vm as unknown as { configure(): Promise<void> }).configure();

    const bootSource = api.requests.find(r => r.path === '/boot-source');
    const bootArgs = (bootSource!.body as { boot_args: string }).boot_args;
    const match = bootArgs.match(/SSH_PUBKEY_B64=(\S+)/);
    expect(match).not.toBeNull();
    expect(Buffer.from(match![1], 'base64').toString()).toBe(pubkey);
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

describe('FirecrackerVM — jailer mode', () => {
  const VM_ID = 'jail';
  let chrootBase: string;
  let chrootRoot: string;
  let api: { requests: RecordedRequest[]; stop: () => void };

  beforeEach(async () => {
    // Short path — AF_UNIX sockets have a ~104 char sun_path limit on macOS, which the
    // default long TMPDIR + nested chroot layout can exceed.
    chrootBase = await fs.mkdtemp('/tmp/bg-jail-');
    chrootRoot = path.join(chrootBase, 'firecracker', VM_ID, 'root');
    await fs.mkdir(chrootRoot, { recursive: true });
    api = await startMockApiServer(path.join(chrootRoot, 'firecracker.sock'));
  });

  afterEach(async () => {
    api.stop();
    await fs.rm(chrootBase, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('configure() uses in-chroot paths for kernel, rootfs, and vsock when jailed', async () => {
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: VM_ID, useJailer: true, jailerChrootBaseDir: chrootBase });
    await (vm as unknown as { configure(): Promise<void> }).configure();

    const bootSource = api.requests.find(r => r.path === '/boot-source');
    expect((bootSource!.body as { kernel_image_path: string }).kernel_image_path).toBe('/vmlinux');

    const drive = api.requests.find(r => r.path === '/drives/rootfs');
    expect((drive!.body as { path_on_host: string }).path_on_host).toBe('/rootfs.img');

    const vsock = api.requests.find(r => r.path === '/vsock');
    expect((vsock!.body as { uds_path: string }).uds_path).toBe('/vsock.sock');
  });

  it('defaults to unjailed when useJailer is not set', () => {
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: VM_ID, jailerChrootBaseDir: chrootBase });
    expect((vm as unknown as { jailed: boolean }).jailed).toBe(false);
  });
});

describe('FirecrackerVM — console log capture', () => {
  it('forwards complete lines to logVmLine tagged with job/vm/worker IDs, buffering partial lines across chunks', async () => {
    const { logVmLine } = await import('../../telemetry/index.js');
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: 'vm-log-test', jobId: 'job-123', workerId: 'worker-abc' });

    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

    (vm as unknown as { attachConsoleCapture(p: typeof proc): void }).attachConsoleCapture(proc);

    // Split a single line across two chunks to verify buffering.
    proc.stdout.emit('data', Buffer.from('Booting Linux ker'));
    proc.stdout.emit('data', Buffer.from('nel...\nStarting sshd\n'));
    proc.stderr.emit('data', Buffer.from('warning: something\n'));

    const attrs = { jobId: 'job-123', vmId: 'vm-log-test', workerId: 'worker-abc' };
    expect(logVmLine).toHaveBeenCalledWith(attrs, 'Booting Linux kernel...');
    expect(logVmLine).toHaveBeenCalledWith(attrs, 'Starting sshd');
    expect(logVmLine).toHaveBeenCalledWith(attrs, 'warning: something');
    expect(logVmLine).toHaveBeenCalledTimes(3);
  });

  it('falls back to vmId and "unknown" when jobId/workerId are not provided', async () => {
    const { logVmLine } = await import('../../telemetry/index.js');
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: 'vm-no-ids' });

    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

    (vm as unknown as { attachConsoleCapture(p: typeof proc): void }).attachConsoleCapture(proc);
    proc.stdout.emit('data', Buffer.from('line one\n'));

    expect(logVmLine).toHaveBeenCalledWith({ jobId: 'vm-no-ids', vmId: 'vm-no-ids', workerId: 'unknown' }, 'line one');
  });
});

describe('FirecrackerVM — per-VM resource sampling', () => {
  afterEach(() => vi.useRealTimers());

  it('does nothing when the process has no pid', () => {
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: 'vm-no-pid' });
    (vm as unknown as { proc: { pid?: number } }).proc = {};
    (vm as unknown as { startResourceSampling(): void }).startResourceSampling();
    expect((vm as unknown as { resourceSampleTimer: unknown }).resourceSampleTimer).toBeNull();
  });

  it('samples CPU/memory from /proc on an interval and reports via recordVmResourceUsage', async () => {
    const { recordVmResourceUsage } = await import('../../telemetry/index.js');
    vi.useFakeTimers();

    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: 'vm-sample', jobId: 'job-9', workerId: 'worker-9' });
    (vm as unknown as { proc: { pid: number } }).proc = { pid: 424242 };

    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (p) => {
      if (String(p).endsWith('/stat')) return '424242 (firecracker) S 1 424242 424242 0 -1 0 0 0 0 0 500 200 0 0 0 0 0 0';
      if (String(p).endsWith('/statm')) return '1000 512 0 0 0 0 0';
      throw new Error(`unexpected path ${p}`);
    });

    (vm as unknown as { startResourceSampling(): void }).startResourceSampling();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(recordVmResourceUsage).toHaveBeenCalledWith(
      { jobId: 'job-9', vmId: 'vm-sample', workerId: 'worker-9' },
      0, // no prior sample yet, so cpuPercent is 0 on the first tick
      512 * 4_096,
    );

    readFileSpy.mockRestore();
  });

  it('shutdown() clears the sampling timer', async () => {
    const vm = new FirecrackerVM({ ...BASE_CFG, vmId: 'vm-shutdown-sample' });
    (vm as unknown as { proc: { pid: number; kill: () => void } }).proc = { pid: 1, kill: vi.fn() };
    (vm as unknown as { startResourceSampling(): void }).startResourceSampling();

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    await vm.shutdown();
    expect(clearIntervalSpy).toHaveBeenCalledWith((vm as unknown as { resourceSampleTimer: unknown }).resourceSampleTimer);
    clearIntervalSpy.mockRestore();
  });
});
