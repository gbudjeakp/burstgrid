import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { FirecrackerVM, type VMConfig } from './firecracker.js';
import { vmSizeFromLabels, type RootfsImage } from '../types/index.js';

/** How the slot executes jobs on this host. */
export type SlotMode = 'firecracker' | 'process' | 'simulate';

// Keys that must never be overridden by job-supplied env vars in process mode.
const BLOCKED_ENV_KEYS = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'IFS', 'BASH_ENV', 'ENV', 'CDPATH',
  'PYTHONPATH', 'RUBYLIB', 'PERL5LIB',
  'NODE_OPTIONS', 'NODE_PATH',
  'PATH',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
]);

function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (BLOCKED_ENV_KEYS.has(k)) {
      console.warn(`[slot] blocked env key from job assignment: ${k}`);
      continue;
    }
    safe[k] = v;
  }
  return safe;
}

export interface SlotConfig {
  jobId: string;
  mode: SlotMode;
  vmImagePath: string;
  kernelPath: string;
  /** Root directory of pre-baked rootfs images; resolved via burstgrid:image=<name> labels. */
  imageDir?: string;
  /** Explicit image catalog from config; takes priority over imageDir convention. */
  imageCatalog?: RootfsImage[];
  /** Runner executable for 'process' mode (bare-metal / GPU hosts). */
  runnerPath?: string;
  /** Docker registry mirror URL passed to VMs as a boot arg (e.g. http://10.0.0.1:5000). */
  registryMirror?: string;
  /** Extra env vars from GpuAmiProfile forwarded to the runner process in 'process' mode. */
  env?: Record<string, string>;
}

export class Slot {
  private vm: FirecrackerVM | null = null;
  private proc: ChildProcess | null = null;
  private procExit: Promise<void> | null = null;

  constructor(private readonly cfg: SlotConfig) {}

  async start(runnerToken: string, labels: string[]): Promise<void> {
    if (this.cfg.mode === 'simulate') return;

    const { memoryMiB, vcpus } = vmSizeFromLabels(labels);

    if (this.cfg.mode === 'firecracker') {
      const rootfsPath = resolveRootfs(labels, this.cfg.imageCatalog, this.cfg.imageDir, this.cfg.vmImagePath);
      const vmCfg: VMConfig = {
        vmId: `bg-${this.cfg.jobId.slice(0, 8)}`,
        kernelPath: this.cfg.kernelPath,
        rootfsPath,
        memoryMiB,
        vcpus,
        runnerToken,
        runnerLabels: labels.join(','),
        registryMirror: this.cfg.registryMirror,
      };
      this.vm = new FirecrackerVM(vmCfg);
      await this.vm.boot();
      return;
    }

    // process mode: spawn the runner script directly without a VM (bare-metal / GPU hosts)
    const child = spawn(this.cfg.runnerPath ?? './run.sh', [], {
      stdio: 'inherit',
      env: { ...process.env, ...sanitizeEnv(this.cfg.env ?? {}), RUNNER_TOKEN: runnerToken, RUNNER_LABELS: labels.join(',') },
    });
    this.proc = child;
    this.procExit = new Promise((resolve, reject) => {
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`runner exited ${code}`))));
      child.on('error', reject);
    });
  }

  async wait(): Promise<void> {
    if (this.cfg.mode === 'simulate') { await sleep(2_000); return; }
    if (this.vm) return this.vm.wait();
    if (this.procExit) return this.procExit;
    throw new Error('slot not started');
  }

  async destroy(): Promise<void> {
    if (this.vm) { await this.vm.shutdown(); this.vm = null; }
    if (this.proc) { this.proc.kill('SIGKILL'); this.proc = null; this.procExit = null; }
  }
}

/**
 * Resolve rootfs path for a job.
 * Priority: explicit catalog entry → imageDir/<name>.img convention → default path.
 */
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

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
