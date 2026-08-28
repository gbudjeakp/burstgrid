import type { JobQueue } from './queue.js';
import type { WorkerPool } from './worker-pool.js';
import { ExecutionTier, vmSizeFromLabels } from '../types/index.js';
import { recordJobDispatched, addJobSpanEvent } from '../telemetry/index.js';
import type { IJobHistoryBackend } from '../backends/types.js';
import type { JobMetaCache } from './job-meta-cache.js';

const STALE_JOB_WARN_MS = 10 * 60 * 1_000;
const TIER_LABEL_MAP: [string, ExecutionTier][] = [
  ['burstgrid:critical', ExecutionTier.Critical],
  ['burstgrid:high-density', ExecutionTier.HighDensity],
  ['burstgrid:gpu-ai', ExecutionTier.GpuAI],
  ['burstgrid:gpu', ExecutionTier.GpuAI],
];

export function selectTier(labels: string[]): ExecutionTier {
  const lower = labels.map(l => l.toLowerCase());
  for (const [label, tier] of TIER_LABEL_MAP) {
    if (lower.includes(label)) return tier;
  }
  return ExecutionTier.Standard;
}

export class Router {
  private readonly timer: NodeJS.Timeout;
  private jobHistory?: IJobHistoryBackend;
  private metaCache?: JobMetaCache;

  attachHistory(backend: IJobHistoryBackend): void {
    this.jobHistory = backend;
  }

  attachJobMetaCache(cache: JobMetaCache): void {
    this.metaCache = cache;
  }

  constructor(
    private readonly queue: JobQueue,
    private readonly pool: WorkerPool,
  ) {
    queue.on('job', () => this.drain());
    // Periodic retry for jobs that had no available worker when enqueued
    this.timer = setInterval(() => this.drain(), 500);
    this.timer.unref();
  }

  private drain(): void {
    for (;;) {
      const job = this.queue.dequeue();
      if (!job) return;

      const { vcpus, memoryMiB } = vmSizeFromLabels(job.labels);
      const workerId = this.pool.bestWorker(job.labels, vcpus, memoryMiB);
      if (!workerId) {
        // Warn if no worker could ever handle this job (e.g. fleet misconfigured for this size)
        if (Date.now() - job.queuedAt.getTime() > STALE_JOB_WARN_MS
            && !this.pool.canAnyWorkerEverHandle(vcpus, memoryMiB, job.labels)) {
          console.warn(`[router] job ${job.id} queued ${Math.round((Date.now() - job.queuedAt.getTime()) / 60_000)}m with no capable workers — check fleet config for size ${vcpus}vCPU/${memoryMiB}MiB`);
        }
        this.queue.requeue(job);
        return;
      }

      const ok = this.pool.assign(workerId, {
        jobId: job.id,
        owner: job.owner,
        repo: job.repo,
        runId: job.runId,
        runnerToken: job.runnerToken,
        labels: job.labels,
        tier: job.tier,
        vcpus,
        memoryMiB,
      });

      if (!ok) {
        this.queue.requeue(job);
        return;
      }

      recordJobDispatched(job.tier, job.queuedAt);
      addJobSpanEvent(job.id, 'dispatched', { workerId });
      this.pool.trackJob(workerId, job);
      this.metaCache?.set(job.id, { owner: job.owner, repo: job.repo, runId: job.runId, tier: job.tier, labels: job.labels });
      void this.jobHistory?.record({
        jobId:             job.id,
        status:            'dispatched',
        workerId:          workerId,
        owner:             job.owner,
        repo:              job.repo,
        runId:             job.runId,
        tier:              job.tier,
        labels:            job.labels,
        timestamp:         new Date(),
        dispatchLatencyMs: Date.now() - job.queuedAt.getTime(),
      }).catch(err => console.error('[router] history record error:', err));
    }
  }
}
