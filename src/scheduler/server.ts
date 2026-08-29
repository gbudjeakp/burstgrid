import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WorkerPool } from './worker-pool.js';
import type { JobQueue } from './queue.js';
import { selectTier } from './router.js';
import type { WorkerRegistration, WorkerHeartbeat, JobUpdate, Job } from '../types/index.js';
import type { JobMetaCache } from './job-meta-cache.js';
import type { IJobHistoryBackend } from '../backends/types.js';
import { recordJobOutcome, addJobSpanEvent, endJobSpan } from '../telemetry/index.js';
import { unmarkProvisioned } from '../github/probe.js';

/**
 * Returns a preHandler that enforces Bearer token auth on worker/job routes.
 * Skipped entirely when token is empty (dev mode).
 */
function makeWorkerAuth(token: string): ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null {
  if (!token) return null;
  const expected = Buffer.from(token);
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = req.headers['authorization'] ?? '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    // timingSafeEqual prevents timing attacks on the token comparison
    if (
      provided.length !== token.length ||
      !crypto.timingSafeEqual(expected, Buffer.from(provided))
    ) {
      req.log.warn({ ip: req.ip, workerId: (req.params as Record<string, string>)?.id }, 'worker auth rejected');
      await reply.status(401).send({ error: 'unauthorized' });
    }
  };
}

export function registerSchedulerRoutes(
  app: FastifyInstance,
  pool: WorkerPool,
  queue: JobQueue,
  workerToken = '',
  opts: { cache?: JobMetaCache; history?: IJobHistoryBackend; isDraining?: () => boolean } = {},
): void {
  const workerAuth = makeWorkerAuth(workerToken);
  const preHandler = workerAuth ? [workerAuth] : [];

  app.post<{ Body: WorkerRegistration }>('/v1/workers/register', { preHandler }, async (req, reply) => {
    const { workerId, totalSlots } = req.body;
    if (!workerId || totalSlots <= 0) {
      return reply.status(400).send({ error: 'workerId and totalSlots required' });
    }
    pool.register(req.body);
    return reply.status(200).send();
  });

  app.post<{ Params: { id: string }; Body: WorkerHeartbeat }>(
    '/v1/workers/:id/heartbeat',
    { preHandler },
    async (req, reply) => {
      pool.heartbeat({ ...req.body, workerId: req.params.id });
      return reply.status(200).send();
    },
  );

  // SSE stream: the scheduler pushes job assignments to workers over a persistent connection
  app.get<{ Params: { id: string } }>('/v1/workers/:id/stream', { preHandler }, (req, reply) => {
    const workerId = req.params.id;
    if (!pool.hasWorker(workerId)) {
      reply.status(404).send({ error: 'worker not registered' });
      return;
    }

    const res = reply.raw;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // prevents nginx from buffering SSE frames
    res.flushHeaders();

    pool.setStream(workerId, res);
    req.log.info({ workerId }, 'worker stream connected');

    const ping = setInterval(() => {
      if (res.writableEnded) { clearInterval(ping); return; }
      res.write(': ping\n\n');
    }, 15_000);

    return new Promise<void>(resolve => {
      req.raw.on('close', () => {
        clearInterval(ping);
        pool.clearStream(workerId);
        req.log.info({ workerId }, 'worker stream disconnected');
        resolve();
      });
    });
  });

  app.post<{ Params: { id: string }; Body: JobUpdate }>(
    '/v1/jobs/:id/status',
    { preHandler },
    async (req, reply) => {
      const jobId = req.params.id;
      const { status, workerId, error } = req.body;
      const meta = opts.cache?.get(jobId);

      req.log.info({ jobId, status, workerId, owner: meta?.owner, repo: meta?.repo, tier: meta?.tier, error }, 'job status update');
      opts.cache?.touchStatus(jobId);
      recordJobOutcome(status as string, meta?.tier ?? 'unknown', meta?.repo ?? 'unknown');
      addJobSpanEvent(jobId, status as string, { workerId, ...(error ? { error } : {}) });

      if (meta && opts.history) {
        void opts.history.record({
          jobId,
          status:    status as 'running' | 'completed' | 'failed',
          workerId,
          owner:     meta.owner,
          repo:      meta.repo,
          runId:     meta.runId,
          tier:      meta.tier,
          labels:    meta.labels,
          timestamp: new Date(),
        }).catch(err => req.log.error({ err, jobId }, 'history record error'));
      }

      const isTerminal = (status as string) === 'completed' || (status as string) === 'failed';
      if (isTerminal) {
        endJobSpan(jobId, (status as string) === 'failed' ? 'error' : 'ok', error);
        opts.cache?.delete(jobId);
        pool.releaseJob(workerId, jobId);
        // On failure, immediately allow re-provisioning so the reconciler can retry on the
        // next cycle rather than waiting for the 30-minute markProvisioned TTL to expire.
        if ((status as string) === 'failed' && meta?.githubJobId != null) {
          unmarkProvisioned(meta.githubJobId);
        }
      }

      return reply.status(200).send();
    },
  );

  app.get('/v1/status', async () => ({
    connectedWorkers: pool.connectedCount,
    totalFreeSlots: pool.totalFreeSlots,
    queuedJobs: queue.depth,
  }));

  app.get('/health/live',  async (_, reply) => reply.status(200).send({ ok: true }));
  app.get('/health/ready', async (_, reply) => {
    const draining = opts.isDraining?.() ?? false;
    return reply.status(draining ? 503 : 200).send({ ready: !draining });
  });
  app.get('/health', async (_, reply) => reply.status(200).send({ ok: true }));

  // Dev-only: inject a job directly without a real GitHub webhook or runner token
  if (process.env.NODE_ENV !== 'production') {
    interface InjectBody { owner: string; repo: string; runId?: number; labels?: string[]; runnerToken?: string }
    app.post<{ Body: InjectBody }>('/v1/jobs/inject', async (req, reply) => {
      const { owner, repo, runId = 0, labels = ['linux', 'x86_64'], runnerToken = 'dev-token' } = req.body;
      if (!owner || !repo) return reply.status(400).send({ error: 'owner and repo required' });
      const job: Job = {
        id: crypto.randomUUID(),
        owner,
        repo,
        runId,
        labels,
        tier: selectTier(labels),
        queuedAt: new Date(),
        runnerToken,
      };
      queue.enqueue(job);
      req.log.info({ jobId: job.id, owner, repo, labels }, 'job injected (dev)');
      return reply.status(202).send({ jobId: job.id });
    });
  }
}
