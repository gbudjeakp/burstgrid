import type { JobAssignment, JobStatus, WorkerHeartbeat, WorkerRegistration, JobUpdate } from '../types/index.js';
import { JobStatus as Status } from '../types/index.js';
import { Slot } from './slot.js';
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
}

export class WorkerAgent {
  private usedSlots = 0;
  private usedVcpus = 0;
  private usedMemoryMiB = 0;

  constructor(private readonly cfg: AgentConfig) {}

  async run(signal: AbortSignal): Promise<void> {
    await this.register();

    const heartbeat = setInterval(() => void this.sendHeartbeat(), 10_000);
    signal.addEventListener('abort', () => clearInterval(heartbeat), { once: true });

    await this.streamLoop(signal);
  }

  private async register(): Promise<void> {
    const reg: WorkerRegistration = {
      workerId: this.cfg.workerId,
      instanceId: this.cfg.workerId,
      region: process.env.AWS_REGION ?? 'us-east-1',
      availabilityZone: process.env.AWS_AZ ?? '',
      totalSlots: this.cfg.maxSlots,
      totalVcpus: this.cfg.totalVcpus,
      totalMemoryMiB: this.cfg.totalMemoryMiB,
      capabilities: this.cfg.capabilities,
    };
    await this.post('/v1/workers/register', reg);
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
      { signal, headers: { Accept: 'text/event-stream' } },
    );
    if (!res.ok || !res.body) throw new Error(`stream connect failed: ${res.status}`);

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
  }

  private async runJob(job: JobAssignment): Promise<void> {
    const jobStart = Date.now();
    this.usedVcpus += job.vcpus;
    this.usedMemoryMiB += job.memoryMiB;
    const slot = new Slot({
      jobId: job.jobId,
      vmImagePath: this.cfg.vmImagePath,
      kernelPath: this.cfg.kernelPath,
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
      this.usedSlots--;
      this.usedVcpus -= job.vcpus;
      this.usedMemoryMiB -= job.memoryMiB;
      recordJobDuration(Date.now() - jobStart, job.tier);
    }
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
