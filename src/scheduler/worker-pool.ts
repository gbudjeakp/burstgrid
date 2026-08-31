import type { ServerResponse } from 'node:http';
import type { WorkerRegistration, WorkerHeartbeat, JobAssignment, Job } from '../types/index.js';
import type { RedisWorkerRegistryBackend } from '../backends/redis.js';

const STALE_TIMEOUT_MS = 120_000; // 4× heartbeat jitter budget — event loop saturation under heavy load delays timers

interface WorkerState extends WorkerRegistration {
  freeSlots: number;
  freeVcpus: number;
  freeMemoryMiB: number;
  lastSeen: number;
  stream: ServerResponse | null;
  /** Timestamp when the worker last became fully idle (freeSlots === totalSlots); null while busy. */
  idleSince: number | null;
}

export class WorkerPool {
  private readonly workers = new Map<string, WorkerState>();
  private readonly inflightJobs = new Map<string, Map<string, Job>>();
  /** Active job count per 'owner/repo' — used for per-repo concurrency limits. */
  private readonly repoInflight = new Map<string, number>();
  private readonly reapTimer: NodeJS.Timeout;
  private redisWorkers?: RedisWorkerRegistryBackend;

  /** Attach a Redis backend to persist worker metadata (survives scheduler restarts). */
  attachRedis(backend: RedisWorkerRegistryBackend): void {
    this.redisWorkers = backend;
  }

  constructor(private readonly onJobsLost?: (jobs: Job[]) => void) {
    this.reapTimer = setInterval(() => {
      const lost = this.reapStale();
      if (lost.length > 0) this.onJobsLost?.(lost);
    }, 15_000);
    this.reapTimer.unref();
  }

  register(reg: WorkerRegistration): void {
    const existing = this.workers.get(reg.workerId);
    const state: WorkerState = {
      ...reg,
      freeSlots:     reg.totalSlots,
      freeVcpus:     reg.totalVcpus,
      freeMemoryMiB: reg.totalMemoryMiB,
      lastSeen:      Date.now(),
      stream:        existing?.stream ?? null,
      idleSince:     existing?.idleSince ?? Date.now(),
    };
    this.workers.set(reg.workerId, state);
    void this.redisWorkers?.upsert({
      workerId:       state.workerId,
      instanceId:     state.instanceId,
      region:         state.region,
      availabilityZone: state.availabilityZone,
      totalSlots:     state.totalSlots,
      totalVcpus:     state.totalVcpus,
      totalMemoryMiB: state.totalMemoryMiB,
      capabilities:   state.capabilities,
      freeSlots:      state.freeSlots,
      freeVcpus:      state.freeVcpus,
      freeMemoryMiB:  state.freeMemoryMiB,
      lastSeen:       state.lastSeen,
    }).catch(err => console.error('[pool] Redis worker upsert error:', err));
  }

  unregister(workerId: string): void {
    this.workers.delete(workerId);
    this.inflightJobs.delete(workerId);
    void this.redisWorkers?.remove(workerId).catch(err =>
      console.error('[pool] Redis worker remove error:', err),
    );
  }

  /** Record that a job has been dispatched to a worker (for re-queue on worker loss). */
  trackJob(workerId: string, job: Job): void {
    if (!this.inflightJobs.has(workerId)) this.inflightJobs.set(workerId, new Map());
    this.inflightJobs.get(workerId)!.set(job.id, job);
    const key = `${job.owner}/${job.repo}`;
    this.repoInflight.set(key, (this.repoInflight.get(key) ?? 0) + 1);
  }

  /** Remove a job from inflight tracking once it reaches a terminal status. */
  releaseJob(workerId: string, jobId: string): void {
    const job = this.inflightJobs.get(workerId)?.get(jobId);
    this.inflightJobs.get(workerId)?.delete(jobId);
    if (job) {
      const key = `${job.owner}/${job.repo}`;
      const n = (this.repoInflight.get(key) ?? 1) - 1;
      if (n <= 0) this.repoInflight.delete(key);
      else this.repoInflight.set(key, n);
    }
    const w = this.workers.get(workerId);
    // Start idle timer when the last job on this worker finishes
    if (w && this.inflightJobs.get(workerId)?.size === 0 && w.idleSince === null) {
      w.idleSince = Date.now();
    }
  }

  /** Return all inflight jobs for a worker and clear the tracking entry. */
  drainWorkerJobs(workerId: string): Job[] {
    const jobs = [...(this.inflightJobs.get(workerId)?.values() ?? [])];
    for (const job of jobs) {
      const key = `${job.owner}/${job.repo}`;
      const n = (this.repoInflight.get(key) ?? 1) - 1;
      if (n <= 0) this.repoInflight.delete(key);
      else this.repoInflight.set(key, n);
    }
    this.inflightJobs.delete(workerId);
    return jobs;
  }

  /** Active inflight job count for a specific repo. */
  runningJobsFor(owner: string, repo: string): number {
    return this.repoInflight.get(`${owner}/${repo}`) ?? 0;
  }

  heartbeat(hb: WorkerHeartbeat): void {
    const w = this.workers.get(hb.workerId);
    if (!w) return;
    w.freeSlots     = hb.freeSlots;
    w.freeVcpus     = hb.freeVcpus;
    w.freeMemoryMiB = hb.freeMemoryMiB;
    w.lastSeen      = Date.now();
    void this.redisWorkers?.upsert({
      workerId:       w.workerId,
      instanceId:     w.instanceId,
      region:         w.region,
      availabilityZone: w.availabilityZone,
      totalSlots:     w.totalSlots,
      totalVcpus:     w.totalVcpus,
      totalMemoryMiB: w.totalMemoryMiB,
      capabilities:   w.capabilities,
      freeSlots:      w.freeSlots,
      freeVcpus:      w.freeVcpus,
      freeMemoryMiB:  w.freeMemoryMiB,
      lastSeen:       w.lastSeen,
    }).catch(err => console.error('[pool] Redis heartbeat sync error:', err));
  }

  hasWorker(workerId: string): boolean {
    return this.workers.has(workerId);
  }

  setStream(workerId: string, stream: ServerResponse): void {
    const w = this.workers.get(workerId);
    if (w) w.stream = stream;
  }

  clearStream(workerId: string): void {
    const w = this.workers.get(workerId);
    if (w) w.stream = null;
  }

  /** Pushes a job assignment as an SSE data event to the worker's active stream. */
  assign(workerId: string, assignment: JobAssignment): boolean {
    const w = this.workers.get(workerId);
    if (!w || w.freeSlots <= 0 || !w.stream?.writable) return false;
    if (w.freeVcpus < assignment.vcpus || w.freeMemoryMiB < assignment.memoryMiB) return false;
    w.freeSlots--;
    w.freeVcpus -= assignment.vcpus;
    w.freeMemoryMiB -= assignment.memoryMiB;
    w.idleSince = null; // worker is no longer idle
    w.stream.write(`data: ${JSON.stringify(assignment)}\n\n`);
    return true;
  }

  bestWorker(requiredLabels: string[], vcpus: number, memoryMiB: number): string | null {
    // Strip size and self-hosted labels — size is checked via resource availability
    const capLabels = requiredLabels.filter(l => !isSchedulerLabel(l));
    let bestId: string | null = null;
    let bestFree = 0;
    for (const [id, w] of this.workers) {
      if (w.freeSlots <= 0 || !w.stream?.writable) continue;
      if (w.freeVcpus < vcpus || w.freeMemoryMiB < memoryMiB) continue;
      if (!hasAll(w.capabilities, capLabels)) continue;
      if (w.freeSlots > bestFree) {
        bestFree = w.freeSlots;
        bestId = id;
      }
    }
    return bestId;
  }

  get connectedCount(): number {
    return [...this.workers.values()].filter(w => w.stream?.writable).length;
  }

  get totalFreeVcpus(): number {
    return [...this.workers.values()]
      .filter(w => w.stream?.writable)
      .reduce((s, w) => s + w.freeVcpus, 0);
  }

  get totalFreeSlots(): number {
    return [...this.workers.values()].reduce((s, w) => s + w.freeSlots, 0);
  }

  /** Free slots on workers that advertise the given capability tag (autoscaler fleet sizing). */
  freeSlotsWithCapability(tag: string): number {
    return [...this.workers.values()]
      .filter(w => w.stream?.writable && (!tag || w.capabilities.includes(tag)))
      .reduce((sum, w) => sum + w.freeSlots, 0);
  }

  workersWithCapability(tag: string): number {
    return [...this.workers.values()]
      .filter(w => w.stream?.writable && (!tag || w.capabilities.includes(tag)))
      .length;
  }

  /**
   * Returns workers that have been fully idle for at least idleMs and have an ec2InstanceId,
   * sorted oldest-idle-first. Used by the autoscaler for scale-down decisions.
   */
  idleWorkers(tag: string, idleMs: number): Array<{ workerId: string; ec2InstanceId: string }> {
    const cutoff = Date.now() - idleMs;
    return [...this.workers.values()]
      .filter(w =>
        w.stream?.writable &&
        w.ec2InstanceId &&
        (!tag || w.capabilities.includes(tag)) &&
        w.idleSince !== null &&
        w.idleSince <= cutoff,
      )
      .sort((a, b) => a.idleSince! - b.idleSince!)
      .map(w => ({ workerId: w.workerId, ec2InstanceId: w.ec2InstanceId! }));
  }

  /**
   * Returns true if any registered worker has enough TOTAL (not free) resources
   * to run a job of this size. Used to detect misconfigured oversized jobs.
   */
  canAnyWorkerEverHandle(vcpus: number, memoryMiB: number, labels: string[]): boolean {
    const capLabels = labels.filter(l => !isSchedulerLabel(l));
    for (const w of this.workers.values()) {
      if (w.totalVcpus >= vcpus && w.totalMemoryMiB >= memoryMiB && hasAll(w.capabilities, capLabels)) {
        return true;
      }
    }
    return false;
  }

  /** Reap stale workers and return any inflight jobs that were on them for re-queuing. */
  reapStale(): Job[] {
    const cutoff = Date.now() - STALE_TIMEOUT_MS;
    const lostJobs: Job[] = [];
    for (const [id, w] of this.workers) {
      if (w.lastSeen < cutoff) {
        this.workers.delete(id);
        lostJobs.push(...this.drainWorkerJobs(id));
        console.warn(`[pool] reaped stale worker ${id}`);
      }
    }
    return lostJobs;
  }
}

function hasAll(have: string[], want: string[]): boolean {
  const set = new Set(have);
  return want.every(l => set.has(l));
}

// Labels consumed by the scheduler itself — not forwarded to capability matching
function isSchedulerLabel(l: string): boolean {
  const lo = l.toLowerCase();
  return lo.startsWith('burstgrid:size=') || lo.startsWith('burstgrid:image=') || lo === 'self-hosted';
}
