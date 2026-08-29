import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { JobQueue } from '../../scheduler/queue.js';
import { registerWebhookRoute, verifySignature } from '../webhook.js';
import { AppClientRegistry } from '../runner.js';
import type { AppClient } from '../runner.js';

const SECRET = 'test-webhook-secret';

function sign(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

function buildApp(secret = SECRET) {
  const app = Fastify({ logger: false });
  const queue = new JobQueue();
  const mockClient = {
    createRunnerToken: vi.fn().mockResolvedValue('runner-token-xyz'),
    // Return empty list so fire-and-forget probeRun does nothing
    listJobsForRun: vi.fn().mockResolvedValue([]),
  } as unknown as AppClient;
  const registry = AppClientRegistry.fromDefault(mockClient);

  // Mirror the content type parser in bin/scheduler.ts
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try { done(null, JSON.parse((body as Buffer).toString())); }
    catch (err) { done(err as Error, undefined); }
  });
  registerWebhookRoute(app, secret, queue, registry);
  return { app, queue, mockClient };
}

// Auto-incrementing ID prevents markProvisioned module state from leaking across tests
let nextWebhookJobId = 1;
function workflowJobPayload(action = 'queued') {
  return {
    action,
    workflow_job: { id: nextWebhookJobId++, run_id: 42, labels: ['self-hosted', 'linux'] },
    repository: { full_name: 'org/repo', name: 'repo', owner: { login: 'org' } },
  };
}

// ─── verifySignature unit tests ───────────────────────────────────────────────

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    const body = Buffer.from('{"action":"queued"}');
    expect(verifySignature(SECRET, sign(body.toString()), body)).toBe(true);
  });

  it('rejects a signature computed over a different body', () => {
    const signed = Buffer.from('{"action":"queued"}');
    const tampered = Buffer.from('{"action":"completed"}');
    expect(verifySignature(SECRET, sign(signed.toString()), tampered)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifySignature(SECRET, undefined, Buffer.from('body'))).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    expect(verifySignature(SECRET, 'deadbeef'.repeat(8), Buffer.from('body'))).toBe(false);
  });

  it('rejects a header with wrong length (malformed hex)', () => {
    expect(verifySignature(SECRET, 'sha256=short', Buffer.from('body'))).toBe(false);
  });

  it('allows all requests when secret is empty (dev mode)', () => {
    expect(verifySignature('', undefined, Buffer.from('body'))).toBe(true);
  });
});

// ─── Webhook handler integration tests ───────────────────────────────────────

describe('POST /webhook/github', () => {
  it('enqueues a queued workflow_job and returns 202', async () => {
    const { app, queue } = buildApp();
    const body = JSON.stringify(workflowJobPayload('queued'));

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/github',
      headers: {
        'x-github-event': 'workflow_job',
        'x-hub-signature-256': sign(body),
        'content-type': 'application/json',
      },
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect(queue.depth).toBe(1);
  });

  it('returns 401 for an invalid signature', async () => {
    const { app } = buildApp();
    const body = JSON.stringify(workflowJobPayload('queued'));

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/github',
      headers: {
        'x-github-event': 'workflow_job',
        'x-hub-signature-256': 'sha256=' + 'a'.repeat(64),
        'content-type': 'application/json',
      },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
  });

  it('ignores non-queued actions and returns 200', async () => {
    const { app, queue } = buildApp();
    const body = JSON.stringify(workflowJobPayload('completed'));

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/github',
      headers: {
        'x-github-event': 'workflow_job',
        'x-hub-signature-256': sign(body),
        'content-type': 'application/json',
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(queue.depth).toBe(0);
  });

  it('ignores non-workflow_job events and returns 200', async () => {
    const { app, queue } = buildApp();
    const body = JSON.stringify({ action: 'created', ref: 'main' });

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/github',
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': sign(body),
        'content-type': 'application/json',
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(queue.depth).toBe(0);
  });

  it('calls createRunnerToken with the correct owner and repo', async () => {
    const { app, mockClient } = buildApp();
    const body = JSON.stringify(workflowJobPayload('queued'));

    await app.inject({
      method: 'POST',
      url: '/webhook/github',
      headers: {
        'x-github-event': 'workflow_job',
        'x-hub-signature-256': sign(body),
        'content-type': 'application/json',
      },
      payload: body,
    });

    expect(mockClient.createRunnerToken).toHaveBeenCalledWith('org', 'repo');
  });

  it('accepts requests when no webhook secret is configured (dev mode)', async () => {
    const { app, queue } = buildApp('');
    const body = JSON.stringify(workflowJobPayload('queued'));

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/github',
      headers: {
        'x-github-event': 'workflow_job',
        'content-type': 'application/json',
      },
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect(queue.depth).toBe(1);
  });

  it('returns 503 and does not enqueue when isDraining is true', async () => {
    const app = Fastify({ logger: false });
    const queue = new JobQueue();
    const mockClient = { createRunnerToken: vi.fn(), listJobsForRun: vi.fn().mockResolvedValue([]) } as unknown as AppClient;
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      req.rawBody = body as Buffer;
      try { done(null, JSON.parse((body as Buffer).toString())); }
      catch (err) { done(err as Error, undefined); }
    });
    registerWebhookRoute(app, SECRET, queue, AppClientRegistry.fromDefault(mockClient), 500, () => true);

    const body = JSON.stringify(workflowJobPayload('queued'));
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/github',
      headers: {
        'x-github-event': 'workflow_job',
        'x-hub-signature-256': sign(body),
        'content-type': 'application/json',
      },
      payload: body,
    });

    expect(res.statusCode).toBe(503);
    expect(queue.depth).toBe(0);
    expect(mockClient.createRunnerToken).not.toHaveBeenCalled();
  });

  it('returns 200 for a duplicate queued event for the same GitHub job ID', async () => {
    const { app, queue } = buildApp();
    const payload = workflowJobPayload('queued');
    const body = JSON.stringify(payload);
    const headers = {
      'x-github-event': 'workflow_job',
      'x-hub-signature-256': sign(body),
      'content-type': 'application/json',
    };

    const first  = await app.inject({ method: 'POST', url: '/webhook/github', headers, payload: body });
    // Send the exact same payload again (same workflow_job.id)
    const second = await app.inject({ method: 'POST', url: '/webhook/github', headers, payload: body });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);  // deduped via markProvisioned
    expect(queue.depth).toBe(1);           // only provisioned once
  });

  it('calls reconciler.triggerNow with the repo from the webhook', async () => {
    const app = Fastify({ logger: false });
    const queue = new JobQueue();
    const mockClient = {
      createRunnerToken: vi.fn().mockResolvedValue('tok'),
      listJobsForRun: vi.fn().mockResolvedValue([]),
    } as unknown as AppClient;
    const reconciler = { triggerNow: vi.fn() };
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      req.rawBody = body as Buffer;
      try { done(null, JSON.parse((body as Buffer).toString())); }
      catch (err) { done(err as Error, undefined); }
    });
    registerWebhookRoute(app, SECRET, queue, AppClientRegistry.fromDefault(mockClient), 500, () => false, reconciler as any);

    const body = JSON.stringify(workflowJobPayload('queued'));
    await app.inject({
      method: 'POST',
      url: '/webhook/github',
      headers: { 'x-github-event': 'workflow_job', 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
      payload: body,
    });

    expect(reconciler.triggerNow).toHaveBeenCalledWith('org', 'repo');
  });

  it('routes to the per-org client when one is registered', async () => {
    const app = Fastify({ logger: false });
    const queue = new JobQueue();
    const defaultClient = { createRunnerToken: vi.fn().mockResolvedValue('default-token'), listJobsForRun: vi.fn().mockResolvedValue([]) } as unknown as AppClient;
    const orgClient = { createRunnerToken: vi.fn().mockResolvedValue('org-token'), listJobsForRun: vi.fn().mockResolvedValue([]) } as unknown as AppClient;
    const registry = AppClientRegistry.fromDefault(defaultClient);
    registry.register('org', orgClient);
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      req.rawBody = body as Buffer;
      try { done(null, JSON.parse((body as Buffer).toString())); }
      catch (err) { done(err as Error, undefined); }
    });
    registerWebhookRoute(app, SECRET, queue, registry);

    const body = JSON.stringify(workflowJobPayload('queued'));
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/github',
      headers: { 'x-github-event': 'workflow_job', 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect(orgClient.createRunnerToken).toHaveBeenCalledWith('org', 'repo');
    expect(defaultClient.createRunnerToken).not.toHaveBeenCalled();
  });
});
