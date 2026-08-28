import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { JobQueue } from '../src/scheduler/queue.js';
import { WorkerPool } from '../src/scheduler/worker-pool.js';
import { Router } from '../src/scheduler/router.js';
import { registerSchedulerRoutes } from '../src/scheduler/server.js';
import { AppClient, AppClientRegistry } from '../src/github/runner.js';
import { registerWebhookRoute } from '../src/github/webhook.js';
import { Autoscaler, type TierFleet } from '../src/fleet/autoscaler.js';
import { loadConfig } from '../src/config/index.js';
import { initTelemetry, registerSchedulerObservers } from '../src/telemetry/index.js';
import { createBackends } from '../src/backends/index.js';
import { JobMetaCache } from '../src/scheduler/job-meta-cache.js';
import { JobWatchdog } from '../src/scheduler/watchdog.js';
import { awaitDrain } from '../src/scheduler/drain.js';
import { recordJobOutcome, addJobSpanEvent, endJobSpan } from '../src/telemetry/index.js';
import type { IJobHistoryBackend } from '../src/backends/types.js';

await initTelemetry('burstgrid-scheduler');

const cfg = loadConfig();

const {
  BURSTGRID_ADDR = '0.0.0.0',
  BURSTGRID_PORT = '8080',
  BURSTGRID_WEBHOOK_SECRET = '',
  BURSTGRID_WORKER_TOKEN = '',
  BURSTGRID_MAX_QUEUE_DEPTH,
  BURSTGRID_LAUNCH_TEMPLATE_ID = '',
  BURSTGRID_SUBNET_IDS = '',
  BURSTGRID_FLEETS,
  GITHUB_APP_ID,
  GITHUB_PRIVATE_KEY_PATH,
  GITHUB_PRIVATE_KEY,
  GITHUB_TOKEN,
} = process.env;

// Env vars override YAML config for backend connection strings
if (cfg.backends?.redis?.url)     process.env.BURSTGRID_REDIS_URL          ??= cfg.backends.redis.url;
if (cfg.backends?.sqs?.queueUrl)  process.env.BURSTGRID_SQS_QUEUE_URL      ??= cfg.backends.sqs.queueUrl;
if (cfg.backends?.sqs?.region)    process.env.BURSTGRID_SQS_REGION          ??= cfg.backends.sqs.region;
if (cfg.backends?.dynamodb?.tableName) process.env.BURSTGRID_DYNAMODB_TABLE ??= cfg.backends.dynamodb.tableName;
if (cfg.backends?.dynamodb?.region)    process.env.BURSTGRID_DYNAMODB_REGION??= cfg.backends.dynamodb.region;

const maxQueueDepth = Number(BURSTGRID_MAX_QUEUE_DEPTH ?? cfg.scheduler?.maxQueueDepth ?? 500);

const queue = new JobQueue();
const pool  = new WorkerPool((lostJobs) => {
  for (const job of lostJobs) {
    console.warn(`[scheduler] re-queuing job ${job.id} from reaped worker`);
    queue.requeue(job);
  }
});
const router = new Router(queue, pool);
const metaCache = new JobMetaCache();
let draining = false;

const backends = createBackends(queue);

if (backends.redisQueue)   queue.attachRedis(backends.redisQueue);
if (backends.redisWorkers) pool.attachRedis(backends.redisWorkers);
if (backends.jobHistory)   router.attachHistory(backends.jobHistory);
router.attachJobMetaCache(metaCache);

function handleJobTimeout(jobId: string, meta: import('../src/scheduler/job-meta-cache.js').CachedJobMeta, reason: string): void {
  console.warn(`[watchdog] job ${jobId} timed out — ${reason}`);
  recordJobOutcome('timeout', meta.tier, meta.repo);
  addJobSpanEvent(jobId, 'timeout', { reason });
  endJobSpan(jobId, 'error', reason);
  void (backends.jobHistory as IJobHistoryBackend | undefined)?.record({
    jobId, status: 'failed', owner: meta.owner, repo: meta.repo,
    runId: meta.runId, tier: meta.tier, labels: meta.labels, timestamp: new Date(),
  }).catch(err => console.error('[watchdog] history error:', err));
  metaCache.delete(jobId);
}

const watchdog = new JobWatchdog(metaCache, handleJobTimeout, {
  dispatchTimeoutMs: cfg.worker?.dispatchTimeoutMs,
  jobTimeoutMs:      cfg.worker?.jobTimeoutMs,
});

// Restore any jobs that were queued before the last restart
await queue.restoreFromRedis();

registerSchedulerObservers(
  () => queue.depth,
  () => pool.connectedCount,
  () => pool.totalFreeSlots,
);

const ghClient = GITHUB_TOKEN
  ? AppClient.fromToken(GITHUB_TOKEN)
  : GITHUB_PRIVATE_KEY
  ? AppClient.fromGitHubAppKey(Number(GITHUB_APP_ID), GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'))
  : AppClient.fromGitHubApp(Number(GITHUB_APP_ID), GITHUB_PRIVATE_KEY_PATH!);

const registry = AppClientRegistry.fromDefault(ghClient);
for (const [org, orgCfg] of Object.entries(cfg.orgs ?? {})) {
  const key = orgCfg.privateKeyEnv
    ? (process.env[orgCfg.privateKeyEnv] ?? '').replace(/\\n/g, '\n')
    : null;
  const orgClient = key
    ? AppClient.fromGitHubAppKey(orgCfg.appId, key)
    : AppClient.fromGitHubApp(orgCfg.appId, orgCfg.privateKeyPath!);
  registry.register(org, orgClient);
}

const app = Fastify({ logger: { level: 'info' } });

// Buffer the body before JSON parsing so the webhook handler can verify HMAC
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  req.rawBody = body as Buffer;
  try {
    done(null, JSON.parse((body as Buffer).toString()));
  } catch (err) {
    done(err as Error, undefined);
  }
});

const rl = cfg.scheduler ?? {};
await app.register(rateLimit, {
  max: rl.rateLimitMax ?? 1000,
  timeWindow: rl.rateLimitWindow ?? '1 minute',
});

registerSchedulerRoutes(app, pool, queue, BURSTGRID_WORKER_TOKEN,
  { cache: metaCache, history: backends.jobHistory, isDraining: () => draining });
registerWebhookRoute(app, BURSTGRID_WEBHOOK_SECRET, queue, registry, maxQueueDepth, () => draining);

// Fleet config: BURSTGRID_FLEETS env (JSON) > burstgrid.config.yaml > legacy single-template env vars
const fleets: TierFleet[] = BURSTGRID_FLEETS
  ? JSON.parse(BURSTGRID_FLEETS) as TierFleet[]
  : cfg.autoscaler?.fleets
  ?? (BURSTGRID_LAUNCH_TEMPLATE_ID
    ? [{ name: 'default', sizeTag: '', launchTemplateId: BURSTGRID_LAUNCH_TEMPLATE_ID, subnetIds: BURSTGRID_SUBNET_IDS.split(',').filter(Boolean), maxWorkers: 50, slotsPerWorker: 8, scaleUpThreshold: 4 }]
    : []);

const autoscalerEnabled = cfg.autoscaler?.enabled !== false;
const autoscaler = new Autoscaler(
  pool, queue, fleets,
  cfg.autoscaler?.evaluationIntervalSec ? cfg.autoscaler.evaluationIntervalSec * 1_000 : undefined,
);
if (autoscalerEnabled) autoscaler.start();
else console.info('[scheduler] autoscaler disabled via config');

const drainTimeoutMs = cfg.scheduler?.drainTimeoutMs ?? 5 * 60 * 1_000;

const shutdown = async () => {
  draining = true;
  console.info(`[scheduler] draining — ${queue.depth} queued, ${metaCache.size} in-flight`);
  const drained = await Promise.race([
    awaitDrain(queue, metaCache).then(() => true),
    new Promise<boolean>(r => setTimeout(() => r(false), drainTimeoutMs)),
  ]);
  if (!drained) {
    console.warn(`[scheduler] drain timeout — ${queue.depth} queued, ${metaCache.size} in-flight jobs abandoned`);
  }
  watchdog.stop();
  autoscaler.stop();
  metaCache.destroy();
  await app.close();
  await backends.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: BURSTGRID_ADDR, port: Number(BURSTGRID_PORT) });
