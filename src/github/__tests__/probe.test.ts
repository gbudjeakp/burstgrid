import { describe, it, expect, vi } from 'vitest';
import { JobQueue } from '../../scheduler/queue.js';
import type { AppClient } from '../runner.js';
import { markProvisioned, unmarkProvisioned, probeRun } from '../probe.js';

vi.mock('../../telemetry/index.js', () => ({ openJobSpan: vi.fn() }));

// Unique IDs per test prevent provisionedIds map state from leaking across cases
let nextJobId = 50_000;
const uid = () => nextJobId++;

function makeClient(jobs: Array<{ id: number; status: string; labels: string[] }> = []) {
  return {
    listJobsForRun: vi.fn().mockResolvedValue(jobs),
    createRunnerToken: vi.fn().mockResolvedValue('tok-abc'),
  } as unknown as AppClient;
}

// ─── markProvisioned / unmarkProvisioned ──────────────────────────────────────

describe('markProvisioned / unmarkProvisioned', () => {
  it('returns true on first call, false on repeat', () => {
    const id = uid();
    expect(markProvisioned(id)).toBe(true);
    expect(markProvisioned(id)).toBe(false);
  });

  it('returns true again after unmark', () => {
    const id = uid();
    markProvisioned(id);
    unmarkProvisioned(id);
    expect(markProvisioned(id)).toBe(true);
  });
});

// ─── probeRun ─────────────────────────────────────────────────────────────────

describe('probeRun', () => {
  it('provisions runners for all queued jobs in the run', async () => {
    const [id1, id2] = [uid(), uid()];
    const queue = new JobQueue();
    const client = makeClient([
      { id: id1, status: 'queued',      labels: ['self-hosted'] },
      { id: id2, status: 'queued',      labels: ['self-hosted'] },
    ]);

    await probeRun({ owner: 'org', repo: 'repo', runId: uid(), client, queue, isDraining: () => false, maxQueueDepth: 100 });

    expect(queue.depth).toBe(2);
    expect(client.createRunnerToken).toHaveBeenCalledTimes(2);
  });

  it('skips jobs that are not in queued status', async () => {
    const queue = new JobQueue();
    const client = makeClient([
      { id: uid(), status: 'in_progress', labels: ['self-hosted'] },
      { id: uid(), status: 'completed',   labels: ['self-hosted'] },
    ]);

    await probeRun({ owner: 'org', repo: 'repo', runId: uid(), client, queue, isDraining: () => false, maxQueueDepth: 100 });

    expect(queue.depth).toBe(0);
  });

  it('skips jobs already marked as provisioned', async () => {
    const id = uid();
    markProvisioned(id);
    const queue = new JobQueue();
    const client = makeClient([{ id, status: 'queued', labels: ['self-hosted'] }]);

    await probeRun({ owner: 'org', repo: 'repo', runId: uid(), client, queue, isDraining: () => false, maxQueueDepth: 100 });

    expect(queue.depth).toBe(0);
    expect(client.createRunnerToken).not.toHaveBeenCalled();
  });

  it('stops provisioning when queue is at maxQueueDepth', async () => {
    const queue = new JobQueue();
    const client = makeClient([
      { id: uid(), status: 'queued', labels: ['self-hosted'] },
      { id: uid(), status: 'queued', labels: ['self-hosted'] },
    ]);

    await probeRun({ owner: 'org', repo: 'repo', runId: uid(), client, queue, isDraining: () => false, maxQueueDepth: 0 });

    expect(queue.depth).toBe(0);
  });

  it('stops provisioning when the scheduler is draining', async () => {
    const queue = new JobQueue();
    const client = makeClient([{ id: uid(), status: 'queued', labels: ['self-hosted'] }]);

    await probeRun({ owner: 'org', repo: 'repo', runId: uid(), client, queue, isDraining: () => true, maxQueueDepth: 100 });

    expect(queue.depth).toBe(0);
  });

  it('resolves without throwing when listJobsForRun rejects', async () => {
    const queue = new JobQueue();
    const client = {
      listJobsForRun: vi.fn().mockRejectedValue(new Error('GitHub 503')),
      createRunnerToken: vi.fn(),
    } as unknown as AppClient;

    await expect(
      probeRun({ owner: 'org', repo: 'repo', runId: uid(), client, queue, isDraining: () => false, maxQueueDepth: 100 }),
    ).resolves.toBeUndefined();
    expect(queue.depth).toBe(0);
  });

  it('unmarks job ID and skips it when createRunnerToken fails, allowing re-provision', async () => {
    const [id1, id2] = [uid(), uid()];
    const queue = new JobQueue();
    const client = {
      listJobsForRun: vi.fn().mockResolvedValue([
        { id: id1, status: 'queued', labels: ['self-hosted'] },
        { id: id2, status: 'queued', labels: ['self-hosted'] },
      ]),
      createRunnerToken: vi.fn()
        .mockRejectedValueOnce(new Error('token error'))
        .mockResolvedValueOnce('tok-ok'),
    } as unknown as AppClient;

    await probeRun({ owner: 'org', repo: 'repo', runId: uid(), client, queue, isDraining: () => false, maxQueueDepth: 100 });

    expect(queue.depth).toBe(1);            // id2 succeeded
    expect(markProvisioned(id1)).toBe(true); // id1 was unmarked on failure
  });

  it('drops a concurrent probe for the same run (per-run lock)', async () => {
    let resolveJobs!: (jobs: Array<{ id: number; status: string; labels: string[] }>) => void;
    const id = uid();
    const runId = uid();
    const client = {
      listJobsForRun: vi.fn().mockImplementation(
        () => new Promise(r => { resolveJobs = r as typeof resolveJobs; }),
      ),
      createRunnerToken: vi.fn().mockResolvedValue('tok'),
    } as unknown as AppClient;
    const queue = new JobQueue();

    const p1 = probeRun({ owner: 'org', repo: 'repo', runId, client, queue, isDraining: () => false, maxQueueDepth: 100 });
    const p2 = probeRun({ owner: 'org', repo: 'repo', runId, client, queue, isDraining: () => false, maxQueueDepth: 100 });
    resolveJobs([{ id, status: 'queued', labels: ['self-hosted'] }]);
    await Promise.all([p1, p2]);

    // Second probe was dropped by the per-run lock
    expect(client.listJobsForRun).toHaveBeenCalledTimes(1);
    expect(queue.depth).toBe(1);
  });
});
