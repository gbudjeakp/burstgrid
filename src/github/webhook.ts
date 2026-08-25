import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { selectTier } from '../scheduler/router.js';
import type { JobQueue } from '../scheduler/queue.js';
import { CircuitOpenError, type AppClient } from './runner.js';
import type { Job } from '../types/index.js';

// Augment Fastify's request type for the rawBody plugin
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

interface WorkflowJobEvent {
  action: string;
  workflow_job: { id: number; run_id: number; labels: string[] };
  repository: { full_name: string; name: string; owner: { login: string } };
}

export function registerWebhookRoute(
  app: FastifyInstance,
  webhookSecret: string,
  queue: JobQueue,
  ghClient: AppClient,
  maxQueueDepth = 500,
): void {
  app.post<{ Body: WorkflowJobEvent }>('/webhook/github', async (req, reply) => {
    const sig = req.headers['x-hub-signature-256'] as string | undefined;

    if (!verifySignature(webhookSecret, sig, req.rawBody ?? Buffer.alloc(0))) {
      return reply.status(401).send({ error: 'invalid signature' });
    }

    if (req.headers['x-github-event'] !== 'workflow_job') {
      return reply.status(200).send();
    }

    const payload = req.body;
    if (payload.action !== 'queued') return reply.status(200).send();

    if (queue.depth >= maxQueueDepth) {
      // 503 triggers GitHub's 72-hour retry window — don't silently drop the event
      return reply.status(503).send({ error: 'scheduler queue full, retry later' });
    }

    const { run_id, labels } = payload.workflow_job;
    const { owner, name: repo, full_name } = payload.repository;

    let runnerToken: string;
    try {
      runnerToken = await ghClient.createRunnerToken(owner.login, repo);
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // Circuit open = GitHub API down; 503 keeps the event in GitHub's retry queue
        return reply.status(503).send({ error: 'service temporarily unavailable, retry later' });
      }
      req.log.error({ err, repo: full_name }, 'runner token error');
      return reply.status(500).send({ error: 'runner token error' });
    }

    const job: Job = {
      id: crypto.randomUUID(),
      owner: owner.login,
      repo,
      runId: run_id,
      labels,
      tier: selectTier(labels),
      queuedAt: new Date(),
      runnerToken,
    };

    queue.enqueue(job);
    req.log.info({ jobId: job.id, repo: full_name, tier: job.tier }, 'job enqueued');
    return reply.status(202).send();
  });
}

export function verifySignature(secret: string, sigHeader: string | undefined, body: Buffer): boolean {
  if (!secret) return true; // dev mode: no secret configured
  if (!sigHeader?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const actual = sigHeader.slice('sha256='.length);
  // Length check prevents RangeError from timingSafeEqual on malformed headers
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
