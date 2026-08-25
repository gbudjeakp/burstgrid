import { Redis } from 'ioredis';
import { createRedisClient, RedisQueueBackend, RedisWorkerRegistryBackend } from './redis.js';
import { SQSJobPoller } from './sqs.js';
import { DynamoDBJobHistory } from './dynamodb.js';
import type { IJobHistoryBackend } from './types.js';
import type { JobQueue } from '../scheduler/queue.js';

export type { IQueueBackend, IWorkerRegistryBackend, IJobHistoryBackend, JobEvent, WorkerSnapshot } from './types.js';
export { RedisQueueBackend, RedisWorkerRegistryBackend } from './redis.js';
export { SQSJobPoller } from './sqs.js';
export { DynamoDBJobHistory } from './dynamodb.js';

export interface ActiveBackends {
  sqsPoller?:      SQSJobPoller;
  jobHistory?:     IJobHistoryBackend;
  redisQueue?:     RedisQueueBackend;
  redisWorkers?:   RedisWorkerRegistryBackend;
  close():         Promise<void>;
}

/**
 * Reads environment variables and wires up optional backends.
 *
 * | Variable                    | Effect                                     |
 * |-----------------------------|---------------------------------------------|
 * | BURSTGRID_REDIS_URL         | Redis queue durability + worker registry    |
 * | BURSTGRID_SQS_QUEUE_URL     | Poll SQS for incoming jobs                 |
 * | BURSTGRID_SQS_REGION        | SQS region (falls back to AWS_REGION)       |
 * | BURSTGRID_DYNAMODB_TABLE    | Write job lifecycle events to DynamoDB      |
 * | BURSTGRID_DYNAMODB_REGION   | DynamoDB region (falls back to AWS_REGION)  |
 */
export function createBackends(queue: JobQueue): ActiveBackends {
  const {
    BURSTGRID_REDIS_URL,
    BURSTGRID_SQS_QUEUE_URL,
    BURSTGRID_SQS_REGION,
    BURSTGRID_DYNAMODB_TABLE,
    BURSTGRID_DYNAMODB_REGION,
    AWS_REGION = 'us-east-1',
  } = process.env;

  let redisQueue:   RedisQueueBackend | undefined;
  let redisWorkers: RedisWorkerRegistryBackend | undefined;
  let sqsPoller:    SQSJobPoller | undefined;
  let jobHistory:   IJobHistoryBackend | undefined;
  const redisClients: Redis[] = [];

  if (BURSTGRID_REDIS_URL) {
    const qRedis = createRedisClient(BURSTGRID_REDIS_URL);
    const wRedis = createRedisClient(BURSTGRID_REDIS_URL);
    redisClients.push(qRedis, wRedis);
    redisQueue   = new RedisQueueBackend(qRedis);
    redisWorkers = new RedisWorkerRegistryBackend(wRedis);
    console.info('[backends] Redis enabled — queue durability + worker registry');
  }

  if (BURSTGRID_SQS_QUEUE_URL) {
    sqsPoller = new SQSJobPoller(
      { queueUrl: BURSTGRID_SQS_QUEUE_URL, region: BURSTGRID_SQS_REGION ?? AWS_REGION },
      queue,
    );
    console.info('[backends] SQS job poller enabled');
  }

  if (BURSTGRID_DYNAMODB_TABLE) {
    jobHistory = new DynamoDBJobHistory(
      BURSTGRID_DYNAMODB_TABLE,
      BURSTGRID_DYNAMODB_REGION ?? AWS_REGION,
    );
    console.info('[backends] DynamoDB job history enabled');
  }

  return {
    redisQueue,
    redisWorkers,
    sqsPoller,
    jobHistory,
    async close() {
      sqsPoller?.stop();
      await Promise.allSettled([
        redisQueue?.close(),
        redisWorkers?.close(),
        jobHistory?.close(),
      ]);
    },
  };
}
