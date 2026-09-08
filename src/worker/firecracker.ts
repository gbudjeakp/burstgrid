import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordVmBootDuration, recordVmResourceUsage, logVmLine, logEvent } from '../telemetry/index.js';

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
  /** Full job ID (not just the truncated vmId) — tags shipped console log lines so they're findable per-job. */
  jobId?: string;
  /** Worker host ID — tags shipped console log lines so they're findable per-worker. */
  workerId?: string;
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
  /**
   * Run Firecracker through the jailer (chroot + dropped-privilege uid/gid) instead of
   * spawning it directly. Firecracker's own docs recommend this for production so a
   * vulnerability in the Firecracker process itself can't reach the rest of the host.
   * Requires the `jailer` binary alongside `firecracker` and a writable chrootBaseDir.
   * Default: false — opt in once jailer is set up on the worker host.
   */
  useJailer?: boolean;
  /** uid the jailer drops Firecracker's privileges to inside the chroot. Default: 123 (Firecracker's own getting-started convention). */
  jailerUid?: number;
  /** gid the jailer drops Firecracker's privileges to inside the chroot. Default: 100. */
  jailerGid?: number;
  /** Base directory jailer creates each VM's chroot jail under (`<dir>/firecracker/<vmId>/root`). Default: /srv/jailer. */
  jailerChrootBaseDir?: string;
  /**
   * SSH public key injected as an authorized key for debug access. Only takes effect if the
   * rootfs image has sshd installed — vm-init.sh no-ops otherwise. No host port is opened for
   * this; the guest is only reachable from the worker host itself over its private /30.
   * Passed as a full "ssh-ed25519 AAAA... comment" string — base64-encoded before it reaches
   * the boot args since the kernel cmdline parser splits on spaces.
   */
  sshPublicKey?: string;
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
  private readonly jailed: boolean;
  private readonly chrootDir: string | null;
  private resourceSampleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: VMConfig) {
    this.jailed = cfg.useJailer ?? false;
    this.chrootDir = this.jailed
      ? path.join(cfg.jailerChrootBaseDir ?? '/srv/jailer', 'firecracker', cfg.vmId, 'root')
      : null;
    // Unjailed: Firecracker's own control socket lives in our tmp sockDir.
    // Jailed: the socket only exists inside the chroot, but that's still a real host path
    // (chroot doesn't hide files from the host, it just changes what Firecracker itself sees as "/"),
    // so we connect to it there directly instead of maintaining a separate tmp sockDir.
    this.sockDir = this.chrootDir ?? path.join(os.tmpdir(), 'burstgrid', cfg.vmId);
    this.sockPath = path.join(this.sockDir, 'firecracker.sock');
    const slot = cfg.slotIndex ?? 0;
    this.tapName = `tap${slot}`;
    // Each slot gets a unique /30: 172.20.0.(slot*4)/30
    this.hostIp  = `172.20.0.${slot * 4 + 1}`;
    this.guestIp = `172.20.0.${slot * 4 + 2}`;
  }

  /** The guest's private IP on the host's TAP subnet (e.g. for an operator to SSH in from the worker host). */
  get guestAddress(): string {
    return this.guestIp;
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

    if (this.jailed) {
      // Jailer chroots Firecracker to this.sockDir (the chroot root) before exec'ing it, so
      // anything Firecracker itself needs to open — the kernel image, the api socket — has to
      // physically exist inside that directory first, referenced by its in-chroot path (relative
      // to the new "/") rather than the real host path.
      const kernelDest = path.join(this.sockDir, 'vmlinux');
      const kernelCopy = spawnSync('cp', [this.cfg.kernelPath, kernelDest]);
      if (kernelCopy.status !== 0) {
        throw new Error(`Failed to stage kernel into jailer chroot: ${kernelCopy.stderr?.toString() ?? 'unknown error'}`);
      }
      spawnSync('chown', [`${this.cfg.jailerUid ?? 123}:${this.cfg.jailerGid ?? 100}`, this.sockDir, copyDest, kernelDest]);

      this.proc = spawn('jailer', [
        '--id', this.cfg.vmId,
        '--exec-file', '/usr/local/bin/firecracker',
        '--uid', String(this.cfg.jailerUid ?? 123),
        '--gid', String(this.cfg.jailerGid ?? 100),
        '--chroot-base-dir', this.cfg.jailerChrootBaseDir ?? '/srv/jailer',
        '--', '--api-sock', '/firecracker.sock',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      this.proc = spawn('firecracker', ['--api-sock', this.sockPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    this.attachConsoleCapture(this.proc);
    this.startResourceSampling();

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
      logEvent('firecracker', 'warn', `boot took ${elapsed}ms — expected <${VM_BOOT_TARGET_MS * 2}ms`);
    }
  }

  /**
   * Restore a previously created snapshot in a fresh Firecracker process.
   * Returns a booted FirecrackerVM ready for injectMmdsToken() + resume().
   *
   * Not yet jailed (unlike boot()) — snapshot/mem files come from an arbitrary host path
   * the jailer chroot staging doesn't handle yet. Forcing useJailer off here keeps this
   * fast-boot path working exactly as before until that's built out.
   */
  static async restoreFromSnapshot(cfg: VMConfig, paths: SnapshotPaths): Promise<FirecrackerVM> {
    const vm = new FirecrackerVM({ ...cfg, useJailer: false });
    await fs.mkdir(vm.sockDir, { recursive: true });
    await fs.unlink(vm.sockPath).catch(() => undefined);

    vm.proc = spawn('firecracker', ['--api-sock', vm.sockPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    vm.attachConsoleCapture(vm.proc);
    vm.startResourceSampling();
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
    if (this.resourceSampleTimer) clearInterval(this.resourceSampleTimer);
    this.proc?.kill('SIGKILL');
    // Jailed chroots may contain files owned by jailerUid/jailerGid rather than our own process,
    // hence sudo — matches how the rest of vm-init.sh / userdata already assumes root on workers.
    if (this.jailed) spawnSync('sudo', ['rm', '-rf', this.sockDir]);
    else await fs.rm(this.sockDir, { recursive: true, force: true });
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

  /**
   * Streams the guest's serial console (kernel boot, vm-init.sh, job output) line-by-line to
   * both local stdout (for anyone tailing the worker's own logs) and the OTel logs pipeline,
   * tagged with job/vm/worker IDs so a specific microVM's output is findable in Grafana instead
   * of only visible mixed into the worker process's own stdout.
   */
  private attachConsoleCapture(proc: ChildProcess): void {
    const attrs = { jobId: this.cfg.jobId ?? this.cfg.vmId, vmId: this.cfg.vmId, workerId: this.cfg.workerId ?? 'unknown' };
    // Buffer partial lines — a chunk boundary rarely lines up with a newline.
    let stdoutBuf = '';
    let stderrBuf = '';
    const forward = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const buf = (stream === 'stdout' ? stdoutBuf : stderrBuf) + chunk.toString('utf-8');
      const lines = buf.split('\n');
      const remainder = lines.pop() ?? '';
      if (stream === 'stdout') stdoutBuf = remainder; else stderrBuf = remainder;
      for (const line of lines) {
        process.stdout.write(`[vm ${this.cfg.vmId}/${stream}] ${line}\n`);
        logVmLine(attrs, line);
      }
    };
    proc.stdout?.on('data', (chunk: Buffer) => forward(chunk, 'stdout'));
    proc.stderr?.on('data', (chunk: Buffer) => forward(chunk, 'stderr'));
  }

  /**
   * Samples this VM's own Firecracker process from /proc every 15s so an operator can see
   * per-VM CPU/memory in Grafana, not just the whole-host aggregate from hostmetrics.
   */
  private startResourceSampling(): void {
    const pid = this.proc?.pid;
    if (!pid) return;
    const attrs = { jobId: this.cfg.jobId ?? this.cfg.vmId, vmId: this.cfg.vmId, workerId: this.cfg.workerId ?? 'unknown' };
    const CLOCK_TICKS_PER_SEC = 100; // USER_HZ — fixed at 100 on every Linux distro we target
    const PAGE_SIZE_BYTES = 4_096;
    let lastCpuTicks = 0;
    let lastSampleAt = Date.now();

    this.resourceSampleTimer = setInterval(() => {
      void (async () => {
        try {
          const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');
          // Fields after the (comm) parenthesized field are space-delimited and fixed-position;
          // comm itself can contain spaces/parens, so split after its closing paren instead of by index.
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          const cpuTicks = Number(fields[11]) + Number(fields[12]); // utime + stime
          const now = Date.now();
          const elapsedSec = (now - lastSampleAt) / 1000;
          const cpuPercent = lastCpuTicks > 0 && elapsedSec > 0
            ? ((cpuTicks - lastCpuTicks) / CLOCK_TICKS_PER_SEC / elapsedSec) * 100
            : 0;
          lastCpuTicks = cpuTicks;
          lastSampleAt = now;

          const statm = await fs.readFile(`/proc/${pid}/statm`, 'utf-8');
          const rssPages = Number(statm.trim().split(' ')[1]);

          recordVmResourceUsage(attrs, cpuPercent, rssPages * PAGE_SIZE_BYTES);
        } catch {
          // Process exited between tick and read (or /proc isn't available, e.g. non-Linux dev
          // machine) — shutdown() clears the timer on the next tick either way.
        }
      })();
    }, 15_000);
    this.resourceSampleTimer.unref(); // don't keep the worker process alive just for sampling
  }

  private async configure(): Promise<void> {
    // Firecracker itself resolves these paths against its own view of "/" — the real host path
    // when unjailed, or the chroot root (this.sockDir) when jailed, where boot() already staged
    // the kernel/rootfs copies and jailer redirects "/" for us.
    const kernelPath = this.jailed ? '/vmlinux' : this.cfg.kernelPath;
    const rootfsPath = this.jailed ? '/rootfs.img' : (this.rootfsCopy ?? this.cfg.rootfsPath);
    const vsockPath = this.jailed ? '/vsock.sock' : path.join(this.sockDir, 'vsock.sock');
    // Base64 avoids spaces breaking the kernel cmdline's space-delimited tokenizing
    // (an SSH public key looks like "ssh-ed25519 AAAA... comment").
    const sshArg = this.cfg.sshPublicKey
      ? ` SSH_PUBKEY_B64=${Buffer.from(this.cfg.sshPublicKey).toString('base64')}`
      : '';

    if (this.cfg.mmdsMode) {
      // MMDS mode: token injected after boot/restore via injectMmdsToken(); boot args are minimal
      const mirrorArg = this.cfg.registryMirror ? ` REGISTRY_MIRROR=${this.cfg.registryMirror}` : '';
      const cacheArg = this.cfg.cacheServerUrl
        ? ` ACTIONS_CACHE_URL=${this.cfg.cacheServerUrl} ACTIONS_RUNTIME_URL=${this.cfg.cacheServerUrl} ACTIONS_RUNTIME_TOKEN=${this.cfg.workerToken ?? ''}`
        : '';
      await this.apiPut('/boot-source', {
        kernel_image_path: kernelPath,
        boot_args: `console=ttyS0 reboot=k panic=1 pci=off init=/sbin/burstgrid-init MMDS_MODE=1 GUEST_IP=${this.guestIp} GATEWAY=${this.hostIp}${mirrorArg}${cacheArg}${sshArg}`,
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
        kernel_image_path: kernelPath,
        boot_args: `console=ttyS0 reboot=k panic=1 pci=off init=/sbin/burstgrid-init RUNNER_TOKEN=${this.cfg.runnerToken} RUNNER_LABELS=${this.cfg.runnerLabels} GUEST_IP=${this.guestIp} GATEWAY=${this.hostIp}${repoArg}${mirrorArg}${ephemeralArg}${cacheArg}${sshArg}`,
      });
    }
    await this.apiPut('/drives/rootfs', {
      drive_id: 'rootfs',
      path_on_host: rootfsPath,
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
      uds_path: vsockPath,
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
