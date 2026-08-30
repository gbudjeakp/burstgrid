import type { JobAssignment, JobStatus, WorkerHeartbeat, WorkerRegistration, JobUpdate, RootfsImage } from '../types/index.js';
import { JobStatus as Status } from '../types/index.js';
import { Slot, type SlotMode } from './slot.js';
import { CacheServer } from './cache-server.js';
import { SnapshotPool } from './snapshot-pool.js';
import { recordJobDuration } from '../telemetry/index.js';

export interface AgentConfig {
  schedulerUrl: string;
  workerId: string;
  maxSlots: number;
  totalVcpus: number;
  totalMemoryMiB: number;
  /** Worker capability labels advertised to the scheduler (e.g. ['linux','x86_64','docker','gpu']). */
  capabilities: string[];
  vmImagePath: string;
  kernelPath: string;
  /** Execution mode: 'firecracker' (default), 'process' (bare-metal/GPU), or 'simulate' (local dev). */
  mode?: SlotMode;
  /** Directory of pre-baked rootfs images for burstgrid:image=<name> label resolution. */
  imageDir?: string;
  /** Explicit image catalog; entries take priority over imageDir convention. */
  imageCatalog?: RootfsImage[];
  /** Runner script path for 'process' mode. */
  runnerPath?: string;
  /** Docker pull-through registry mirror URL forwarded to each VM. */
  registryMirror?: string;
  /** Shared secret for authenticating to the scheduler. Set BURSTGRID_WORKER_TOKEN on both sides. */
  workerToken?: string;
  /** S3-backed Actions cache. When set, a CacheServer starts and ACTIONS_CACHE_URL is injected into VMs. */
  s3Cache?: { bucketName: string; region?: string; keyPrefix?: string };
  /** Pre-warmed snapshot pool config. When set, the agent initialises a SnapshotPool on startup. */
  snapshotPoolCfg?: { size?: number; snapshotDir?: string };
}

export class WorkerAgent {
  private usedSlots = 0;
  private usedVcpus = 0;
  private usedMemoryMiB = 0;
  private registered = false;
  private streamConnected = false;
  private cacheServer: CacheServer | null = null;
  private snapshotPool: SnapshotPool | null = null;
  // Each index maps to an isolated runner directory; pop on acquire, push on release.
  private freeSlotIndices: number[];

  isReady(): boolean { return this.registered && this.streamConnected; }

  constructor(private readonly cfg: AgentConfig) {
    this.freeSlotIndices = Array.from({ length: cfg.maxSlots }, (_, i) => i);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.cfg.s3Cache) {
      this.cacheServer = new CacheServer({
        ...this.cfg.s3Cache,
        workerToken: this.cfg.workerToken ?? '',
      });
      await this.cacheServer.start();
      signal.addEventListener('abort', () => this.cacheServer?.stop(), { once: true });
    }

    if (this.cfg.snapshotPoolCfg && (this.cfg.mode ?? 'firecracker') === 'firecracker') {
      this.snapshotPool = new SnapshotPool({
        poolSize: this.cfg.snapshotPoolCfg.size,
        snapshotDir: this.cfg.snapshotPoolCfg.snapshotDir,
        vmBase: {
          vmId: 'warmup',
          kernelPath: this.cfg.kernelPath,
          rootfsPath: this.cfg.vmImagePath,
          memoryMiB: 2_048,
          vcpus: 2,
          registryMirror: this.cfg.registryMirror,
          cacheServerUrl: this.cacheServer ? `http://127.0.0.1:${this.cacheServer.port}/` : undefined,
          workerToken: this.cfg.workerToken,
        },
      });
      await this.snapshotPool.warmUp();
    }

    await this.register();

    const heartbeat = setInterval(() => void this.sendHeartbeat(), 10_000);
    signal.addEventListener('abort', () => clearInterval(heartbeat), { once: true });

    await this.streamLoop(signal);
  }

  private async register(): Promise<void> {
    const reg: WorkerRegistration = {
      workerId: this.cfg.workerId,
      instanceId: this.cfg.workerId,
      ec2InstanceId: await fetchEC2InstanceId(),
      region: process.env.AWS_REGION ?? 'us-east-1',
      availabilityZone: process.env.AWS_AZ ?? '',
      totalSlots: this.cfg.maxSlots,
      totalVcpus: this.cfg.totalVcpus,
      totalMemoryMiB: this.cfg.totalMemoryMiB,
      capabilities: this.cfg.capabilities,
    };
    await this.post('/v1/workers/register', reg);
    this.registered = true;
    console.info(`[agent] registered ${this.cfg.workerId} (${this.cfg.maxSlots} slots, ${this.cfg.totalVcpus} vCPU, ${this.cfg.totalMemoryMiB} MiB)`);
  }

  private async sendHeartbeat(): Promise<void> {
    const hb: WorkerHeartbeat = {
      workerId: this.cfg.workerId,
      freeSlots: this.cfg.maxSlots - this.usedSlots,
      usedSlots: this.usedSlots,
      freeVcpus: this.cfg.totalVcpus - this.usedVcpus,
      freeMemoryMiB: this.cfg.totalMemoryMiB - this.usedMemoryMiB,
    };
    await this.post(`/v1/workers/${this.cfg.workerId}/heartbeat`, hb).catch(err =>
      console.warn('[agent] heartbeat failed', err),
    );
  }

  /** Connects to the scheduler SSE stream with exponential-backoff reconnect on failure. */
  private async streamLoop(signal: AbortSignal): Promise<void> {
    let delay = 1_000;
    while (!signal.aborted) {
      try {
        await this.connectStream(signal);
        delay = 1_000; // reset backoff on clean disconnect
      } catch (err) {
        if (signal.aborted) return;
        console.warn(`[agent] stream error, reconnecting in ${delay}ms`, err);
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
        // Re-register in case the scheduler restarted and lost our state
        await this.register().catch(e => console.warn('[agent] re-register failed', e));
      }
    }
  }

  private async connectStream(signal: AbortSignal): Promise<void> {
    const res = await fetch(
      `${this.cfg.schedulerUrl}/v1/workers/${this.cfg.workerId}/stream`,
      { signal, headers: { Accept: 'text/event-stream', ...this.authHeader() } },
    );
    if (!res.ok || !res.body) throw new Error(`stream connect failed: ${res.status}`);
    this.streamConnected = true;
    try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const assignment = JSON.parse(line.slice(6)) as JobAssignment;
          if (this.usedSlots < this.cfg.maxSlots) {
            this.usedSlots++;
            void this.runJob(assignment);
          } else {
            console.warn('[agent] received job at capacity — slot accounting drift detected');
          }
        } catch {
          console.warn('[agent] unparseable SSE event', line);
        }
      }
    }
    } finally {
      this.streamConnected = false;
    }
  }

  private async runJob(job: JobAssignment): Promise<void> {
    const jobStart = Date.now();
    this.usedVcpus += job.vcpus;
    this.usedMemoryMiB += job.memoryMiB;
    const slotIndex = this.freeSlotIndices.pop() ?? 0;
    const slot = new Slot({
      jobId: job.jobId,
      mode: this.cfg.mode ?? 'firecracker',
      vmImagePath: this.cfg.vmImagePath,
      kernelPath: this.cfg.kernelPath,
      imageDir: this.cfg.imageDir,
      imageCatalog: this.cfg.imageCatalog,
      runnerPath: this.cfg.runnerPath,
      registryMirror: job.registryMirror ?? this.cfg.registryMirror,
      cacheServerUrl: this.cacheServer ? `http://127.0.0.1:${this.cacheServer.port}/` : undefined,
      workerToken: this.cfg.workerToken,
      snapshotPool: this.snapshotPool ?? undefined,
      env: job.env,
      repoUrl: `https://github.com/${job.owner}/${job.repo}`,
      slotIndex,
    });

    try {
      await slot.start(job.runnerToken, job.labels);
      await this.reportStatus(job.jobId, Status.Running);
      await slot.wait();
      await this.reportStatus(job.jobId, Status.Completed);
    } catch (err) {
      await this.reportStatus(job.jobId, Status.Failed, String(err));
    } finally {
      await slot.destroy().catch(err => console.warn('[agent] slot cleanup error', err));
      this.freeSlotIndices.push(slotIndex);
      this.usedSlots--;
      this.usedVcpus -= job.vcpus;
      this.usedMemoryMiB -= job.memoryMiB;
      recordJobDuration(Date.now() - jobStart, job.tier);
    }
  }

  /** Notify the scheduler to immediately requeue all inflight jobs for this worker. */
  async evict(): Promise<void> {
    await this.post(`/v1/workers/${this.cfg.workerId}/evict`, {}).catch(err =>
      console.warn('[agent] evict request failed — scheduler will requeue via heartbeat timeout', err),
    );
  }

  private async reportStatus(jobId: string, status: JobStatus, error?: string): Promise<void> {
    const body: JobUpdate = { jobId, workerId: this.cfg.workerId, status, error };
    await this.post(`/v1/jobs/${jobId}/status`, body).catch(err =>
      console.warn('[agent] status report failed', err),
    );
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.cfg.schedulerUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeader(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  }

  private authHeader(): Record<string, string> {
    return this.cfg.workerToken ? { Authorization: `Bearer ${this.cfg.workerToken}` } : {};
  }
}

/** Fetches the EC2 instance ID from the IMDS; returns undefined when not on EC2. */
async function fetchEC2InstanceId(): Promise<string | undefined> {
  try {
    const res = await fetch('http://169.254.169.254/latest/meta-data/instance-id', {
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok ? (await res.text()).trim() : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
