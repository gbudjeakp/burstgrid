import type { JobQueue } from './queue.js';
import type { WorkerPool } from './worker-pool.js';
import { ExecutionTier, vmSizeFromLabels } from '../types/index.js';
import type { Job } from '../types/index.js';
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
  private concurrencyLimits: Record<string, number> = {};
  private defaultRepoConcurrency?: number;

  attachHistory(backend: IJobHistoryBackend): void {
    this.jobHistory = backend;
  }

  attachJobMetaCache(cache: JobMetaCache): void {
    this.metaCache = cache;
  }

  setConcurrencyLimits(limits: Record<string, number>, defaultLimit?: number): void {
    this.concurrencyLimits = limits;
    this.defaultRepoConcurrency = defaultLimit;
  }

  /** Returns the concurrency cap for owner/repo, checking specific then org-wildcard then default. */
  private limitFor(owner: string, repo: string): number | undefined {
    return this.concurrencyLimits[`${owner}/${repo}`]
      ?? this.concurrencyLimits[`${owner}/*`]
      ?? this.defaultRepoConcurrency;
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
    // Collect jobs that can't be dispatched this cycle and re-add them after
    const skipped: Job[] = [];
    for (;;) {
      const job = this.queue.dequeue();
      if (!job) break;

      const { vcpus, memoryMiB } = vmSizeFromLabels(job.labels);
      // Parse per-job Docker mirror override from label: extras=docker-mirror=<url>
      const mirrorLabel = job.labels.find(l => l.toLowerCase().startsWith('extras=docker-mirror='));
      const registryMirror = mirrorLabel ? mirrorLabel.slice('extras=docker-mirror='.length) : undefined;

      // Per-repo concurrency limit — hold the job in queue until a slot opens
      const concurrencyLimit = this.limitFor(job.owner, job.repo);
      if (concurrencyLimit !== undefined && this.pool.runningJobsFor(job.owner, job.repo) >= concurrencyLimit) {
        skipped.push(job);
        continue;
      }

      const workerId = this.pool.bestWorker(job.labels, vcpus, memoryMiB);
      if (!workerId) {
        // Warn if no worker could ever handle this job (e.g. fleet misconfigured for this size)
        if (Date.now() - job.queuedAt.getTime() > STALE_JOB_WARN_MS
            && !this.pool.canAnyWorkerEverHandle(vcpus, memoryMiB, job.labels)) {
          console.warn(`[router] job ${job.id} queued ${Math.round((Date.now() - job.queuedAt.getTime()) / 60_000)}m with no capable workers — check fleet config for size ${vcpus}vCPU/${memoryMiB}MiB`);
        }
        skipped.push(job);
        continue;
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
        registryMirror,
      });

      if (!ok) {
        skipped.push(job);
        continue;
      }

      recordJobDispatched(job.tier, job.queuedAt);
      addJobSpanEvent(job.id, 'dispatched', { workerId });
      this.pool.trackJob(workerId, job);
      this.metaCache?.set(job.id, { owner: job.owner, repo: job.repo, runId: job.runId, tier: job.tier, labels: job.labels, githubJobId: job.githubJobId });
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
    // Re-add jobs that couldn't be dispatched this cycle (at back of queue to avoid starvation)
    for (const job of skipped) this.queue.enqueueSkipped(job);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
