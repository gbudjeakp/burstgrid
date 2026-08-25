import { EventEmitter } from 'node:events';
import type { Job } from '../types/index.js';
import { ExecutionTier } from '../types/index.js';

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

  enqueue(job: Job): void {
    job.queuedAt = new Date();
    this.queues.get(job.tier)!.push(job);
    this.emit('job');
  }

  dequeue(): Job | undefined {
    for (const tier of TIER_PRIORITY) {
      const q = this.queues.get(tier)!;
      if (q.length > 0) return q.shift();
    }
    return undefined;
  }

  requeue(job: Job): void {
    this.queues.get(job.tier)!.unshift(job);
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
