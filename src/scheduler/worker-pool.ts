import type { ServerResponse } from 'node:http';
import type { WorkerRegistration, WorkerHeartbeat, JobAssignment } from '../types/index.js';
import type { RedisWorkerRegistryBackend } from '../backends/redis.js';

const STALE_TIMEOUT_MS = 30_000;

interface WorkerState extends WorkerRegistration {
  freeSlots: number;
  freeVcpus: number;
  freeMemoryMiB: number;
  lastSeen: number;
  stream: ServerResponse | null;
}

export class WorkerPool {
  private readonly workers = new Map<string, WorkerState>();
  private readonly reapTimer: NodeJS.Timeout;
  private redisWorkers?: RedisWorkerRegistryBackend;

  /** Attach a Redis backend to persist worker metadata (survives scheduler restarts). */
  attachRedis(backend: RedisWorkerRegistryBackend): void {
    this.redisWorkers = backend;
  }

  constructor() {
    this.reapTimer = setInterval(() => this.reapStale(), 15_000);
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
    void this.redisWorkers?.remove(workerId).catch(err =>
      console.error('[pool] Redis worker remove error:', err),
    );
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

  private reapStale(): void {
    const cutoff = Date.now() - STALE_TIMEOUT_MS;
    for (const [id, w] of this.workers) {
      if (w.lastSeen < cutoff) {
        this.workers.delete(id);
        console.warn(`[pool] reaped stale worker ${id}`);
      }
    }
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
