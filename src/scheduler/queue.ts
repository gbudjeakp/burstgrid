import { EventEmitter } from 'node:events';
import type { Job } from '../types/index.js';
import { ExecutionTier } from '../types/index.js';
import type { RedisQueueBackend } from '../backends/redis.js';

const TIER_PRIORITY: ExecutionTier[] = [
  ExecutionTier.Critical,
  ExecutionTier.Standard,
  ExecutionTier.HighDensity,
  ExecutionTier.Overflow,
];

export class JobQueue extends EventEmitter {
  private readonly queues = new Map<ExecutionTier, Job[]>(
    TIER_PRIORITY.map(t => [t, []]),
  );
  private redisBackend?: RedisQueueBackend;

  /** Attach a Redis backend for job durability and cross-instance pub/sub wakeup. */
  attachRedis(backend: RedisQueueBackend): void {
    this.redisBackend = backend;
    void backend.subscribeJobNotifications(() => this.emit('job'));
  }

  /** Restore jobs persisted in Redis into the in-memory queue (call once on startup). */
  async restoreFromRedis(): Promise<void> {
    if (!this.redisBackend) return;
    let count = 0;
    for await (const job of this.redisBackend.jobs()) {
      job.queuedAt = new Date(job.queuedAt); // re-hydrate Date from JSON
      this.queues.get(job.tier)!.push(job);
      count++;
    }
    if (count > 0) console.info(`[queue] restored ${count} jobs from Redis`);
  }

  enqueue(job: Job): void {
    job.queuedAt = new Date();
    this.queues.get(job.tier)!.push(job);
    this.emit('job');
    void this.redisBackend?.enqueue(job).catch(err =>
      console.error('[queue] Redis enqueue error:', err),
    );
  }

  dequeue(): Job | undefined {
    for (const tier of TIER_PRIORITY) {
      const q = this.queues.get(tier)!;
      if (q.length > 0) {
        const job = q.shift()!;
        void this.redisBackend?.removeById(job.id).catch(err =>
          console.error('[queue] Redis remove error:', err),
        );
        return job;
      }
    }
    return undefined;
  }

  requeue(job: Job): void {
    this.queues.get(job.tier)!.unshift(job);
    void this.redisBackend?.requeue(job).catch(err =>
      console.error('[queue] Redis requeue error:', err),
    );
  }

  /** Iterates all queued jobs across all tiers in priority order (for autoscaler counting). */
  *jobs(): IterableIterator<Job> {
    for (const tier of TIER_PRIORITY) {
      yield* this.queues.get(tier)!;
    }
  }

  get depth(): number {
    return [...this.queues.values()].reduce((sum, q) => sum + q.length, 0);
  }
}
