import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordVmBootDuration } from '../telemetry/index.js';

/** Performance contract: Firecracker microVMs should boot within this window. */
export const VM_BOOT_TARGET_MS = 150;

export interface VMConfig {
  vmId: string;
  kernelPath: string;
  rootfsPath: string;
  memoryMiB: number;
  vcpus: number;
  runnerToken: string;
  runnerLabels: string;
  /** Pull-through registry mirror URL injected as REGISTRY_MIRROR boot arg; init reads /proc/cmdline. */
  registryMirror?: string;
  /** S3 cache server URL injected as ACTIONS_CACHE_URL boot arg. */
  cacheServerUrl?: string;
  /** Worker token injected as ACTIONS_RUNTIME_TOKEN so the VM can authenticate to the cache server. */
  workerToken?: string;
  /** When true, passes runner_ephemeral=1 as a boot arg so the init script runs the runner with --ephemeral. */
  runnerEphemeral?: boolean;
  /**
   * When true, configures the MMDS device and omits token/labels from boot args.
   * The guest init script polls http://169.254.169.254/ for runner-token and runner-labels.
   * Required for snapshot-based boot (token injected after restore via injectMmdsToken).
   */
  mmdsMode?: boolean;
}

export interface SnapshotPaths {
  snapshotPath: string;
  memFilePath: string;
}

export class FirecrackerVM {
  private readonly sockDir: string;
  private readonly sockPath: string;
  private proc: ChildProcess | null = null;
  private exitPromise: Promise<void> | null = null;

  constructor(private readonly cfg: VMConfig) {
    this.sockDir = path.join(os.tmpdir(), 'burstgrid', cfg.vmId);
    this.sockPath = path.join(this.sockDir, 'firecracker.sock');
  }

  async boot(): Promise<void> {
    const bootStart = Date.now();
    await fs.mkdir(this.sockDir, { recursive: true });

    this.proc = spawn('firecracker', ['--api-sock', this.sockPath], {
      stdio: 'inherit',
    });

    this.exitPromise = new Promise((resolve, reject) => {
      this.proc!.on('exit', code => (code === 0 ? resolve() : reject(new Error(`firecracker exited ${code}`))));
      this.proc!.on('error', reject);
    });

    await this.waitForSocket(5_000);
    await this.configure();
    // Scrub the token from heap — it has already been transmitted to the Firecracker API socket
    Object.assign(this.cfg, { runnerToken: '' });
    await this.apiPut('/actions', { action_type: 'InstanceStart' });
    const elapsed = Date.now() - bootStart;
    recordVmBootDuration(elapsed);
    if (elapsed > VM_BOOT_TARGET_MS * 2) {
      console.warn(`[firecracker] boot took ${elapsed}ms — expected <${VM_BOOT_TARGET_MS * 2}ms`);
    }
  }

  /**
   * Restore a previously created snapshot in a fresh Firecracker process.
   * Returns a booted FirecrackerVM ready for injectMmdsToken() + resume().
   */
  static async restoreFromSnapshot(cfg: VMConfig, paths: SnapshotPaths): Promise<FirecrackerVM> {
    const vm = new FirecrackerVM(cfg);
    await fs.mkdir(vm.sockDir, { recursive: true });

    vm.proc = spawn('firecracker', ['--api-sock', vm.sockPath], { stdio: 'inherit' });
    vm.exitPromise = new Promise((resolve, reject) => {
      vm.proc!.on('exit', code => (code === 0 ? resolve() : reject(new Error(`firecracker exited ${code}`))));
      vm.proc!.on('error', reject);
    });

    await vm.waitForSocket(5_000);
    await vm.apiPut('/snapshot/load', {
      snapshot_path: paths.snapshotPath,
      mem_file_path: paths.memFilePath,
      enable_diff_snapshots: false,
    });
    return vm;
  }

  /** Save a full memory snapshot of this VM (pauses VM). */
  async createSnapshot(paths: SnapshotPaths): Promise<void> {
    await fs.mkdir(path.dirname(paths.snapshotPath), { recursive: true });
    await this.apiPut('/snapshot/create', {
      snapshot_type: 'Full',
      snapshot_path: paths.snapshotPath,
      mem_file_path: paths.memFilePath,
    });
  }

  /** Inject runner token and labels via MMDS so a paused (snapshot-restored) VM can resume. */
  async injectMmdsToken(runnerToken: string, runnerLabels: string): Promise<void> {
    await this.apiPatch('/mmds', {
      latest: { 'meta-data': { 'runner-token': runnerToken, 'runner-labels': runnerLabels } },
    });
  }

  /** Resume a paused VM (after snapshot load or after createSnapshot). */
  async resume(): Promise<void> {
    await this.apiPut('/actions', { action_type: 'Resume' });
  }

  async wait(): Promise<void> {
    if (!this.exitPromise) throw new Error('VM not booted');
    return this.exitPromise;
  }

  async shutdown(): Promise<void> {
    this.proc?.kill('SIGKILL');
    await fs.rm(this.sockDir, { recursive: true, force: true });
  }

  private async configure(): Promise<void> {
    if (this.cfg.mmdsMode) {
      // MMDS mode: token injected after boot/restore via injectMmdsToken(); boot args are minimal
      const mirrorArg = this.cfg.registryMirror ? ` REGISTRY_MIRROR=${this.cfg.registryMirror}` : '';
      const cacheArg = this.cfg.cacheServerUrl
        ? ` ACTIONS_CACHE_URL=${this.cfg.cacheServerUrl} ACTIONS_RUNTIME_URL=${this.cfg.cacheServerUrl} ACTIONS_RUNTIME_TOKEN=${this.cfg.workerToken ?? ''}`
        : '';
      await this.apiPut('/boot-source', {
        kernel_image_path: this.cfg.kernelPath,
        boot_args: `console=ttyS0 reboot=k panic=1 pci=off MMDS_MODE=1${mirrorArg}${cacheArg}`,
      });
      // Pre-populate MMDS with empty token so guest poll doesn't 404 on first request
      await this.apiPut('/mmds/config', { ipv4_address: '169.254.169.254', network_interfaces: [] });
      await this.apiPut('/mmds', { latest: { 'meta-data': { 'runner-token': '', 'runner-labels': '' } } });
    } else {
      // Boot-arg mode (default): token + labels baked into kernel cmdline
      const mirrorArg = this.cfg.registryMirror ? ` REGISTRY_MIRROR=${this.cfg.registryMirror}` : '';
      const ephemeralArg = this.cfg.runnerEphemeral ? ' runner_ephemeral=1' : '';
      const cacheArg = this.cfg.cacheServerUrl
        ? ` ACTIONS_CACHE_URL=${this.cfg.cacheServerUrl} ACTIONS_RUNTIME_URL=${this.cfg.cacheServerUrl} ACTIONS_RUNTIME_TOKEN=${this.cfg.workerToken ?? ''}`
        : '';
      await this.apiPut('/boot-source', {
        kernel_image_path: this.cfg.kernelPath,
        boot_args: `console=ttyS0 reboot=k panic=1 pci=off RUNNER_TOKEN=${this.cfg.runnerToken} RUNNER_LABELS=${this.cfg.runnerLabels}${mirrorArg}${ephemeralArg}${cacheArg}`,
      });
    }
    await this.apiPut('/drives/rootfs', {
      drive_id: 'rootfs',
      path_on_host: this.cfg.rootfsPath,
      is_root_device: true,
      is_read_only: false,
    });
    await this.apiPut('/machine-config', {
      vcpu_count: this.cfg.vcpus,
      mem_size_mib: this.cfg.memoryMiB,
    });
    // Vsock device — guest CID 3; processes inside the VM can reach the host
    // OTel Collector at vsock CID 2 (VMADDR_CID_HOST), port 4317/4318
    await this.apiPut('/vsock', {
      guest_cid: 3,
      uds_path: path.join(this.sockDir, 'vsock.sock'),
    });
  }

  /** Firecracker's management API is served over a Unix domain socket. */
  private apiPut(apiPath: string, body: unknown): Promise<void> {
    return this.apiRequest('PUT', apiPath, body);
  }

  private apiPatch(apiPath: string, body: unknown): Promise<void> {
    return this.apiRequest('PATCH', apiPath, body);
  }

  private apiRequest(method: string, apiPath: string, body: unknown): Promise<void> {
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.sockPath,
          path: apiPath,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        res => {
          res.resume();
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Firecracker ${apiPath} returned ${res.statusCode}`));
          } else {
            resolve();
          }
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  private async waitForSocket(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fs.access(this.sockPath);
        return;
      } catch {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    throw new Error(`socket ${this.sockPath} not ready after ${timeoutMs}ms`);
  }
}
