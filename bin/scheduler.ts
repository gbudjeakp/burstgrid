import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { JobQueue } from '../src/scheduler/queue.js';
import { WorkerPool } from '../src/scheduler/worker-pool.js';
import { Router } from '../src/scheduler/router.js';
import { registerSchedulerRoutes } from '../src/scheduler/server.js';
import { AppClient } from '../src/github/runner.js';
import { registerWebhookRoute } from '../src/github/webhook.js';
import { Autoscaler, type TierFleet } from '../src/fleet/autoscaler.js';
import { loadConfig } from '../src/config/index.js';
import { initTelemetry, registerSchedulerObservers } from '../src/telemetry/index.js';

await initTelemetry('burstgrid-scheduler');

const cfg = loadConfig();

const {
  BURSTGRID_ADDR = '0.0.0.0',
  BURSTGRID_PORT = '8080',
  BURSTGRID_WEBHOOK_SECRET = '',
  BURSTGRID_MAX_QUEUE_DEPTH,
  BURSTGRID_LAUNCH_TEMPLATE_ID = '',
  BURSTGRID_SUBNET_IDS = '',
  BURSTGRID_FLEETS,
  GITHUB_APP_ID,
  GITHUB_PRIVATE_KEY_PATH,
  GITHUB_TOKEN,
} = process.env;

const maxQueueDepth = Number(BURSTGRID_MAX_QUEUE_DEPTH ?? cfg.scheduler?.maxQueueDepth ?? 500);

const queue = new JobQueue();
const pool = new WorkerPool();
new Router(queue, pool);

registerSchedulerObservers(
  () => queue.depth,
  () => pool.connectedCount,
  () => pool.totalFreeSlots,
);

const ghClient = GITHUB_TOKEN
  ? AppClient.fromToken(GITHUB_TOKEN)
  : AppClient.fromGitHubApp(Number(GITHUB_APP_ID), GITHUB_PRIVATE_KEY_PATH!);

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

registerSchedulerRoutes(app, pool, queue);
registerWebhookRoute(app, BURSTGRID_WEBHOOK_SECRET, queue, ghClient, maxQueueDepth);

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

const shutdown = async () => {
  autoscaler.stop();
  await app.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: BURSTGRID_ADDR, port: Number(BURSTGRID_PORT) });
