import type { ServerResponse } from 'node:http';
import type { WorkerRegistration, WorkerHeartbeat, JobAssignment } from '../types/index.js';

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

  constructor() {
    this.reapTimer = setInterval(() => this.reapStale(), 15_000);
    this.reapTimer.unref();
  }

  register(reg: WorkerRegistration): void {
    const existing = this.workers.get(reg.workerId);
    this.workers.set(reg.workerId, {
      ...reg,
      freeSlots: reg.totalSlots,
      freeVcpus: reg.totalVcpus,
      freeMemoryMiB: reg.totalMemoryMiB,
      lastSeen: Date.now(),
      stream: existing?.stream ?? null, // preserve stream across re-registrations
    });
  }

  unregister(workerId: string): void {
    this.workers.delete(workerId);
  }

  heartbeat(hb: WorkerHeartbeat): void {
    const w = this.workers.get(hb.workerId);
    if (w) {
      w.freeSlots = hb.freeSlots;
      w.freeVcpus = hb.freeVcpus;
      w.freeMemoryMiB = hb.freeMemoryMiB;
      w.lastSeen = Date.now();
    }
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
    const capLabels = requiredLabels.filter(
      l => !l.toLowerCase().startsWith('burstgrid:size=') && l.toLowerCase() !== 'self-hosted'
    );
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
    const capLabels = labels.filter(
      l => !l.toLowerCase().startsWith('burstgrid:size=') && l.toLowerCase() !== 'self-hosted'
    );
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
