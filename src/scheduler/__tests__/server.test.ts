import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { JobQueue } from '../queue.js';
import { WorkerPool } from '../worker-pool.js';
import { registerSchedulerRoutes } from '../server.js';

function buildApp(workerToken = '') {
  const app = Fastify({ logger: false });
  registerSchedulerRoutes(app, new WorkerPool(), new JobQueue(), workerToken);
  return app;
}

const REG_BODY = JSON.stringify({
  workerId: 'w-1', instanceId: 'w-1', region: 'us-east-1',
  availabilityZone: 'a', totalSlots: 4, totalVcpus: 8, totalMemoryMiB: 16_384,
  capabilities: ['linux'],
});
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ─── No token configured (dev mode) ──────────────────────────────────────────

describe('worker auth — no token (dev mode)', () => {
  it('allows register without any Authorization header', async () => {
    const res = await buildApp('').inject({
      method: 'POST', url: '/v1/workers/register',
      headers: JSON_HEADERS, body: REG_BODY,
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─── Token enforced ───────────────────────────────────────────────────────────

describe('worker auth — token enforced', () => {
  const TOKEN = 'correct-token-abc123';

  it('returns 401 when Authorization header is absent', async () => {
    const res = await buildApp(TOKEN).inject({
      method: 'POST', url: '/v1/workers/register',
      headers: JSON_HEADERS, body: REG_BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('returns 401 on wrong token', async () => {
    const res = await buildApp(TOKEN).inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { ...JSON_HEADERS, Authorization: 'Bearer wrong-token' },
      body: REG_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when the scheme is not Bearer', async () => {
    const res = await buildApp(TOKEN).inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { ...JSON_HEADERS, Authorization: `Basic ${TOKEN}` },
      body: REG_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the correct Bearer token', async () => {
    const res = await buildApp(TOKEN).inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${TOKEN}` },
      body: REG_BODY,
    });
    expect(res.statusCode).toBe(200);
  });

  it('applies auth to the SSE stream endpoint too', async () => {
    const res = await buildApp(TOKEN).inject({
      method: 'GET', url: '/v1/workers/w-1/stream',
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not apply auth to /health', async () => {
    const res = await buildApp(TOKEN).inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

// ─── Spot evict ─────────────────────────────────────────────────────────────

describe('POST /v1/workers/:id/evict', () => {
  it('requeues inflight jobs and unregisters the worker', async () => {
    const pool = new WorkerPool();
    const queue = new JobQueue();
    const app = Fastify({ logger: false });
    registerSchedulerRoutes(app, pool, queue);

    // Register worker
    await app.inject({
      method: 'POST', url: '/v1/workers/register',
      headers: JSON_HEADERS, body: REG_BODY,
    });

    // Simulate a tracked inflight job
    const job = {
      id: 'j-1', owner: 'o', repo: 'r', runId: 1,
      labels: ['linux'], tier: 'standard' as const, queuedAt: new Date(), runnerToken: 't',
    };
    pool.trackJob('w-1', job);

    const res = await app.inject({ method: 'POST', url: '/v1/workers/w-1/evict', headers: JSON_HEADERS, body: '{}' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ requeued: 1 });
    expect(queue.depth).toBe(1);
    expect(pool.hasWorker('w-1')).toBe(false);
  });

  it('returns requeued: 0 and unregisters when no inflight jobs', async () => {
    const pool = new WorkerPool();
    const app = Fastify({ logger: false });
    registerSchedulerRoutes(app, pool, new JobQueue());
    await app.inject({ method: 'POST', url: '/v1/workers/register', headers: JSON_HEADERS, body: REG_BODY });

    const res = await app.inject({ method: 'POST', url: '/v1/workers/w-1/evict', headers: JSON_HEADERS, body: '{}' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ requeued: 0 });
    expect(pool.hasWorker('w-1')).toBe(false);
  });
});

// ─── Health / readiness endpoints ────────────────────────────────────────────

describe('health and readiness', () => {
  it('/health/live always returns 200', async () => {
    const app = Fastify({ logger: false });
    registerSchedulerRoutes(app, new WorkerPool(), new JobQueue(), '', { isDraining: () => true });
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
  });

  it('/health/ready returns 200 when not draining', async () => {
    const app = Fastify({ logger: false });
    registerSchedulerRoutes(app, new WorkerPool(), new JobQueue(), '', { isDraining: () => false });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true });
  });

  it('/health/ready returns 503 when draining', async () => {
    const app = Fastify({ logger: false });
    registerSchedulerRoutes(app, new WorkerPool(), new JobQueue(), '', { isDraining: () => true });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ready: false });
  });
});
