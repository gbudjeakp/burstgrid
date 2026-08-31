import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
  /** GitHub repo URL (https://github.com/owner/repo) — required for runner registration. */
  repoUrl?: string;
  /** When true, passes runner_ephemeral=1 as a boot arg so the init script runs the runner with --ephemeral. */
  runnerEphemeral?: boolean;
  /**
   * When true, configures the MMDS device and omits token/labels from boot args.
   * The guest init script polls http://169.254.169.254/ for runner-token and runner-labels.
   * Required for snapshot-based boot (token injected after restore via injectMmdsToken).
   */
  mmdsMode?: boolean;
  /**
   * Slot index (0-based) used to allocate a unique TAP device and /30 subnet per VM.
   * Slot N gets tap{N}, host IP 172.20.0.(N*4+1)/30, guest IP 172.20.0.(N*4+2).
   */
  slotIndex?: number;
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
  private readonly tapName: string;
  private readonly hostIp: string;
  private readonly guestIp: string;
  /** Per-VM sparse copy of rootfs — prevents concurrent VMs from sharing a writable ext4 image. */
  private rootfsCopy: string | null = null;

  constructor(private readonly cfg: VMConfig) {
    this.sockDir = path.join(os.tmpdir(), 'burstgrid', cfg.vmId);
    this.sockPath = path.join(this.sockDir, 'firecracker.sock');
    const slot = cfg.slotIndex ?? 0;
    this.tapName = `tap${slot}`;
    // Each slot gets a unique /30: 172.20.0.(slot*4)/30
    this.hostIp  = `172.20.0.${slot * 4 + 1}`;
    this.guestIp = `172.20.0.${slot * 4 + 2}`;
  }

  async boot(): Promise<void> {
    const bootStart = Date.now();
    await fs.mkdir(this.sockDir, { recursive: true });
    // Remove a stale socket from a previous (crashed) run so Firecracker can bind.
    await fs.unlink(this.sockPath).catch(() => undefined);

    // Each VM needs its own writable ext4 image — sharing a single file across concurrent VMs
    // causes ext4 journal corruption and kernel panics. We use a sparse copy so only the
    // actually-written blocks consume disk space (the ~138 MB of real content in a 3 GB image).
    const copyDest = path.join(this.sockDir, 'rootfs.img');
    const cpResult = spawnSync('cp', ['--sparse=always', this.cfg.rootfsPath, copyDest]);
    if (cpResult.status !== 0) {
      throw new Error(`Failed to create rootfs sparse copy: ${cpResult.stderr?.toString() ?? 'unknown error'}`);
    }
    this.rootfsCopy = copyDest;

    this.setupTap();

    this.proc = spawn('firecracker', ['--api-sock', this.sockPath], {
      stdio: 'inherit',
    });

    this.exitPromise = new Promise((resolve, reject) => {
      this.proc!.on('exit', code => (code === 0 ? resolve() : reject(new Error(`firecracker exited ${code}`))));
      this.proc!.on('error', reject);
    });
    // Prevent unhandled-rejection crash if boot() throws before wait() is ever called
    // (e.g. disk-full during rootfs copy → shutdown() SIGKILLs proc in the finally block).
    this.exitPromise.catch(() => {});

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
    await fs.unlink(vm.sockPath).catch(() => undefined);

    vm.proc = spawn('firecracker', ['--api-sock', vm.sockPath], { stdio: 'inherit' });
    vm.exitPromise = new Promise((resolve, reject) => {
      vm.proc!.on('exit', code => (code === 0 ? resolve() : reject(new Error(`firecracker exited ${code}`))));
      vm.proc!.on('error', reject);
    });
    vm.exitPromise.catch(() => {});

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
    this.teardownTap();
  }

  private setupTap(): void {
    spawnSync('ip', ['tuntap', 'add', this.tapName, 'mode', 'tap']);
    spawnSync('ip', ['addr', 'add', `${this.hostIp}/30`, 'dev', this.tapName]);
    spawnSync('ip', ['link', 'set', this.tapName, 'up']);
  }

  private teardownTap(): void {
    spawnSync('ip', ['link', 'del', this.tapName]);
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
        boot_args: `console=ttyS0 reboot=k panic=1 pci=off init=/sbin/burstgrid-init MMDS_MODE=1 GUEST_IP=${this.guestIp} GATEWAY=${this.hostIp}${mirrorArg}${cacheArg}`,
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
      const repoArg = this.cfg.repoUrl ? ` RUNNER_REPO_URL=${this.cfg.repoUrl}` : '';
      await this.apiPut('/boot-source', {
        kernel_image_path: this.cfg.kernelPath,
        boot_args: `console=ttyS0 reboot=k panic=1 pci=off init=/sbin/burstgrid-init RUNNER_TOKEN=${this.cfg.runnerToken} RUNNER_LABELS=${this.cfg.runnerLabels} GUEST_IP=${this.guestIp} GATEWAY=${this.hostIp}${repoArg}${mirrorArg}${ephemeralArg}${cacheArg}`,
      });
    }
    await this.apiPut('/drives/rootfs', {
      drive_id: 'rootfs',
      path_on_host: this.rootfsCopy ?? this.cfg.rootfsPath,
      is_root_device: true,
      is_read_only: false,
    });
    await this.apiPut('/machine-config', {
      vcpu_count: this.cfg.vcpus,
      mem_size_mib: this.cfg.memoryMiB,
    });
    await this.apiPut('/network-interfaces/eth0', {
      iface_id: 'eth0',
      guest_mac: `AA:FC:00:00:00:${String(this.cfg.slotIndex ?? 0).padStart(2, '0')}`,
      host_dev_name: this.tapName,
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
