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
  /** When true, passes runner_ephemeral=1 as a boot arg so the init script runs the runner with --ephemeral. */
  runnerEphemeral?: boolean;
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

  async wait(): Promise<void> {
    if (!this.exitPromise) throw new Error('VM not booted');
    return this.exitPromise;
  }

  async shutdown(): Promise<void> {
    this.proc?.kill('SIGKILL');
    await fs.rm(this.sockDir, { recursive: true, force: true });
  }

  private async configure(): Promise<void> {
    // Runner token + labels are passed as kernel boot args; the rootfs init reads /proc/cmdline
    const mirrorArg = this.cfg.registryMirror ? ` REGISTRY_MIRROR=${this.cfg.registryMirror}` : '';
    const ephemeralArg = this.cfg.runnerEphemeral ? ' runner_ephemeral=1' : '';
    await this.apiPut('/boot-source', {
      kernel_image_path: this.cfg.kernelPath,
      boot_args: `console=ttyS0 reboot=k panic=1 pci=off RUNNER_TOKEN=${this.cfg.runnerToken} RUNNER_LABELS=${this.cfg.runnerLabels}${mirrorArg}${ephemeralArg}`,
    });
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
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.sockPath,
          path: apiPath,
          method: 'PUT',
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
