import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WorkerPool } from './worker-pool.js';
import type { JobQueue } from './queue.js';
import { selectTier } from './router.js';
import type { WorkerRegistration, WorkerHeartbeat, JobUpdate, Job } from '../types/index.js';

export function registerSchedulerRoutes(
  app: FastifyInstance,
  pool: WorkerPool,
  queue: JobQueue,
): void {
  app.post<{ Body: WorkerRegistration }>('/v1/workers/register', async (req, reply) => {
    const { workerId, totalSlots } = req.body;
    if (!workerId || totalSlots <= 0) {
      return reply.status(400).send({ error: 'workerId and totalSlots required' });
    }
    pool.register(req.body);
    return reply.status(200).send();
  });

  app.post<{ Params: { id: string }; Body: WorkerHeartbeat }>(
    '/v1/workers/:id/heartbeat',
    async (req, reply) => {
      pool.heartbeat({ ...req.body, workerId: req.params.id });
      return reply.status(200).send();
    },
  );

  // SSE stream: the scheduler pushes job assignments to workers over a persistent connection
  app.get<{ Params: { id: string } }>('/v1/workers/:id/stream', (req, reply) => {
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
    async (req, reply) => {
      req.log.info({ jobId: req.params.id, status: req.body.status, workerId: req.body.workerId }, 'job status update');
      return reply.status(200).send();
    },
  );

  app.get('/v1/status', async () => ({
    connectedWorkers: pool.connectedCount,
    totalFreeSlots: pool.totalFreeSlots,
    queuedJobs: queue.depth,
  }));

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
