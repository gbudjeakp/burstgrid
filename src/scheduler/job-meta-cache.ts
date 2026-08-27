import { EventEmitter } from 'node:events';
import type { ExecutionTier } from '../types/index.js';

export interface CachedJobMeta {
  owner: string;
  repo: string;
  runId: number;
  tier: ExecutionTier;
  labels: string[];
  /** unix ms, set at insertion time */
  cachedAt: number;
  /** unix ms, updated whenever any status update arrives */
  lastStatusAt?: number;
}

const TTL_MS = 60 * 60 * 1_000;        // evict entries older than 1 hour
const EVICT_INTERVAL_MS = 5 * 60 * 1_000;

export class JobMetaCache extends EventEmitter {
  private readonly store = new Map<string, CachedJobMeta>();
  private readonly timer: NodeJS.Timeout;

  constructor() {
    super();
    this.timer = setInterval(() => this.evict(), EVICT_INTERVAL_MS);
    this.timer.unref();
  }

  set(jobId: string, meta: Omit<CachedJobMeta, 'cachedAt'>): void {
    this.store.set(jobId, { ...meta, cachedAt: Date.now() });
  }

  get(jobId: string): CachedJobMeta | undefined {
    return this.store.get(jobId);
  }

  delete(jobId: string): void {
    const existed = this.store.delete(jobId);
    if (existed && this.store.size === 0) this.emit('drain');
  }

  /** Record that a status update arrived for this job (used by the watchdog). */
  touchStatus(jobId: string): void {
    const entry = this.store.get(jobId);
    if (entry) entry.lastStatusAt = Date.now();
  }

  get size(): number {
    return this.store.size;
  }

  private evict(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, meta] of this.store) {
      if (meta.cachedAt < cutoff) this.store.delete(id);
    }
  }

  destroy(): void {
    clearInterval(this.timer);
  }
}
