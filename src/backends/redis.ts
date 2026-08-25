import { Redis } from 'ioredis';
import { ExecutionTier, type Job } from '../types/index.js';
import type { IQueueBackend, IWorkerRegistryBackend, WorkerSnapshot } from './types.js';

const QUEUE_ZSET   = 'burstgrid:queue';
const JOB_HASH     = (id: string) => `burstgrid:job:${id}`;
const WORKER_HASH  = (id: string) => `burstgrid:worker:${id}`;
const WORKER_SET   = 'burstgrid:workers';
const JOB_CHANNEL  = 'burstgrid:jobs';
const WORKER_TTL_S = 90; // expires if no heartbeat in 90 s

// Lower score = dispatched sooner
const TIER_SCORE: Record<ExecutionTier, number> = {
  [ExecutionTier.Critical]:    1_000_000_000_000,
  [ExecutionTier.Standard]:    2_000_000_000_000,
  [ExecutionTier.HighDensity]: 3_000_000_000_000,
  [ExecutionTier.Overflow]:    4_000_000_000_000,
};

export class RedisQueueBackend implements IQueueBackend {
  private sub: Redis;

  constructor(private readonly redis: Redis) {
    this.sub = redis.duplicate();
  }

  async enqueue(job: Job): Promise<void> {
    const score = TIER_SCORE[job.tier] + job.queuedAt.getTime();
    const pipe = this.redis.pipeline();
    pipe.zadd(QUEUE_ZSET, score, job.id);
    pipe.hset(JOB_HASH(job.id), this.serialize(job));
    await pipe.exec();
    await this.redis.publish(JOB_CHANNEL, '1');
  }

  async removeById(jobId: string): Promise<void> {
    const pipe = this.redis.pipeline();
    pipe.zrem(QUEUE_ZSET, jobId);
    pipe.del(JOB_HASH(jobId));
    await pipe.exec();
  }

  async requeue(job: Job): Promise<void> {
    // NX: only add if not already present (don't reset score)
    await this.redis.zadd(QUEUE_ZSET, 'NX', TIER_SCORE[job.tier] + job.queuedAt.getTime(), job.id);
  }

  async depth(): Promise<number> {
    return this.redis.zcard(QUEUE_ZSET);
  }

  async *jobs(): AsyncGenerator<Job> {
    const ids = await this.redis.zrange(QUEUE_ZSET, 0, -1);
    for (const id of ids) {
      const raw = await this.redis.hgetall(JOB_HASH(id));
      if (Object.keys(raw).length) yield this.deserialize(raw);
    }
  }

  async subscribeJobNotifications(fn: () => void): Promise<void> {
    await this.sub.subscribe(JOB_CHANNEL);
    this.sub.on('message', (channel) => { if (channel === JOB_CHANNEL) fn(); });
  }

  async close(): Promise<void> {
    await this.sub.quit();
    await this.redis.quit();
  }

  private serialize(job: Job): Record<string, string> {
    return {
      id:          job.id,
      owner:       job.owner,
      repo:        job.repo,
      runId:       String(job.runId),
      labels:      JSON.stringify(job.labels),
      tier:        job.tier,
      queuedAt:    job.queuedAt.toISOString(),
      runnerToken: job.runnerToken,
    };
  }

  private deserialize(raw: Record<string, string>): Job {
    return {
      id:          raw.id,
      owner:       raw.owner,
      repo:        raw.repo,
      runId:       Number(raw.runId),
      labels:      JSON.parse(raw.labels) as string[],
      tier:        raw.tier as ExecutionTier,
      queuedAt:    new Date(raw.queuedAt),
      runnerToken: raw.runnerToken,
    };
  }
}

export class RedisWorkerRegistryBackend implements IWorkerRegistryBackend {
  constructor(private readonly redis: Redis) {}

  async upsert(snapshot: WorkerSnapshot): Promise<void> {
    const key = WORKER_HASH(snapshot.workerId);
    await this.redis.hset(key, {
      ...snapshot,
      capabilities: JSON.stringify(snapshot.capabilities),
      lastSeen:     String(snapshot.lastSeen),
    });
    await this.redis.expire(key, WORKER_TTL_S);
    await this.redis.sadd(WORKER_SET, snapshot.workerId);
  }

  async remove(workerId: string): Promise<void> {
    await this.redis.del(WORKER_HASH(workerId));
    await this.redis.srem(WORKER_SET, workerId);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export function createRedisClient(url: string): Redis {
  return new Redis(url, { lazyConnect: true, enableReadyCheck: true });
}
