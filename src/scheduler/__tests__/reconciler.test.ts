import { describe, it, expect, vi, afterEach } from 'vitest';
import { JobQueue } from '../queue.js';
import { Reconciler } from '../reconciler.js';
import type { AppClientRegistry } from '../../github/runner.js';

vi.mock('../../github/probe.js', () => ({
  probeRun: vi.fn().mockResolvedValue(undefined),
}));

// Import the mocked probeRun for assertions
const { probeRun } = await import('../../github/probe.js');
const mockedProbeRun = vi.mocked(probeRun);

function makeRegistry(runs: Array<{ id: number }> = []) {
  const client = { listActiveRuns: vi.fn().mockResolvedValue(runs) };
  const registry = { clientFor: vi.fn().mockReturnValue(client) };
  return { registry: registry as unknown as AppClientRegistry, client };
}

async function flush() {
  // Two microtask ticks to let fire-and-forget async chains complete
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Reconciler', () => {
  it('reconciles watched repos immediately on start', async () => {
    const { registry, client } = makeRegistry([{ id: 1 }, { id: 2 }]);
    const queue = new JobQueue();
    const r = new Reconciler(registry, queue, () => false, 500, ['org/repo']);

    r.start();
    await flush();
    r.stop();

    expect(client.listActiveRuns).toHaveBeenCalledWith('org', 'repo');
    expect(mockedProbeRun).toHaveBeenCalledTimes(2);
    expect(mockedProbeRun).toHaveBeenCalledWith(expect.objectContaining({ owner: 'org', repo: 'repo', runId: 1 }));
    expect(mockedProbeRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 2 }));
  });

  it('seeds multiple repos from the watched list', async () => {
    const { registry, client } = makeRegistry([]);
    const queue = new JobQueue();
    const r = new Reconciler(registry, queue, () => false, 500, ['org-a/repo-x', 'org-b/repo-y']);

    r.start();
    await flush();
    r.stop();

    expect(client.listActiveRuns).toHaveBeenCalledWith('org-a', 'repo-x');
    expect(client.listActiveRuns).toHaveBeenCalledWith('org-b', 'repo-y');
  });

  it('trackRepo adds a repo and includes it in the next reconcile', async () => {
    const { registry, client } = makeRegistry([{ id: 99 }]);
    const queue = new JobQueue();
    const r = new Reconciler(registry, queue, () => false, 500, []);

    r.trackRepo('acme', 'infra');
    r.start();
    await flush();
    r.stop();

    expect(client.listActiveRuns).toHaveBeenCalledWith('acme', 'infra');
    expect(mockedProbeRun).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated trackRepo calls for the same repo', async () => {
    const { registry, client } = makeRegistry([{ id: 1 }]);
    const queue = new JobQueue();
    const r = new Reconciler(registry, queue, () => false, 500, []);

    r.trackRepo('org', 'repo');
    r.trackRepo('org', 'repo');
    r.start();
    await flush();
    r.stop();

    expect(client.listActiveRuns).toHaveBeenCalledTimes(1);
  });

  it('does not call probeRun when there are no active runs', async () => {
    const { registry } = makeRegistry([]);
    const queue = new JobQueue();
    const r = new Reconciler(registry, queue, () => false, 500, ['org/repo']);

    r.start();
    await flush();
    r.stop();

    expect(mockedProbeRun).not.toHaveBeenCalled();
  });

  it('continues reconciling other repos when one throws', async () => {
    const clientA = { listActiveRuns: vi.fn().mockRejectedValue(new Error('GitHub 503')) };
    const clientB = { listActiveRuns: vi.fn().mockResolvedValue([]) };
    const registry = {
      clientFor: vi.fn().mockImplementation((owner: string) =>
        owner === 'org-a' ? clientA : clientB,
      ),
    } as unknown as AppClientRegistry;
    const queue = new JobQueue();
    const r = new Reconciler(registry, queue, () => false, 500, ['org-a/repo', 'org-b/repo']);

    r.start();
    await flush();
    r.stop();

    expect(clientA.listActiveRuns).toHaveBeenCalled();
    expect(clientB.listActiveRuns).toHaveBeenCalled(); // proceeds despite org-a error
  });

  it('triggerNow reconciles the repo after a 250 ms debounce', async () => {
    vi.useFakeTimers();
    const { registry, client } = makeRegistry([{ id: 42 }]);
    const queue = new JobQueue();
    const r = new Reconciler(registry, queue, () => false, 500, []);

    r.triggerNow('acme', 'api');
    expect(client.listActiveRuns).not.toHaveBeenCalled(); // not yet

    await vi.runAllTimersAsync();

    expect(client.listActiveRuns).toHaveBeenCalledWith('acme', 'api');
    expect(mockedProbeRun).toHaveBeenCalledTimes(1);
  });

  it('triggerNow debounces concurrent calls for the same repo into one reconcile', async () => {
    vi.useFakeTimers();
    const { registry, client } = makeRegistry([]);
    const queue = new JobQueue();
    const r = new Reconciler(registry, queue, () => false, 500, []);

    r.triggerNow('org', 'repo');
    r.triggerNow('org', 'repo');
    r.triggerNow('org', 'repo');

    await vi.runAllTimersAsync();

    expect(client.listActiveRuns).toHaveBeenCalledTimes(1);
  });

  it('triggerNow skips reconcile when draining', async () => {
    vi.useFakeTimers();
    const { registry, client } = makeRegistry([{ id: 1 }]);
    const queue = new JobQueue();
    const r = new Reconciler(registry, queue, () => true, 500, []);

    r.triggerNow('org', 'repo');
    vi.runAllTimers();
    await Promise.resolve(); await Promise.resolve();

    expect(client.listActiveRuns).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('stop() cancels the recurring interval', async () => {
    vi.useFakeTimers();
    const { registry, client } = makeRegistry([]);
    const queue = new JobQueue();
    const r = new Reconciler(registry, queue, () => false, 1_000, ['org/repo']);

    r.start();
    // Flush Promise microtasks so the startup reconcile completes
    await Promise.resolve();
    await Promise.resolve();
    const callsAfterStart = client.listActiveRuns.mock.calls.length;

    r.stop();
    vi.advanceTimersByTime(10_000); // would trigger 10 interval callbacks if not stopped

    expect(client.listActiveRuns).toHaveBeenCalledTimes(callsAfterStart); // no new calls
  });

  it('prunes repos with no active runs after the inactivity window', async () => {
    vi.useFakeTimers();
    const { registry, client } = makeRegistry([]); // always 0 active runs
    const queue = new JobQueue();
    // Set intervalMs just over 6h so only 2-3 reconcile cycles happen during the test
    const PRUNE_MS = 6 * 60 * 60_000;
    const r = new Reconciler(registry, queue, () => false, 500, ['org/stale'], PRUNE_MS + 1);

    r.start();
    await vi.advanceTimersByTimeAsync(0); // startup reconcile — no active runs, countdown starts
    expect(client.listActiveRuns).toHaveBeenCalledTimes(1);

    // Second cycle fires just after the 6h prune window — pruneInactive() removes the repo
    await vi.advanceTimersByTimeAsync(PRUNE_MS + 2);
    expect(client.listActiveRuns).toHaveBeenCalledTimes(2);

    // Third cycle fires but the repo is gone — no more listActiveRuns calls
    await vi.advanceTimersByTimeAsync(PRUNE_MS + 2);
    expect(client.listActiveRuns).toHaveBeenCalledTimes(2);
    r.stop();
  });

  it('keeps repos with recent active runs beyond the inactivity window', async () => {
    vi.useFakeTimers();
    const { registry, client } = makeRegistry([{ id: 1 }]); // always has active runs
    const queue = new JobQueue();
    const PRUNE_MS = 6 * 60 * 60_000;
    const r = new Reconciler(registry, queue, () => false, 500, ['org/active'], PRUNE_MS + 1);

    r.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PRUNE_MS + 2);
    await vi.advanceTimersByTimeAsync(PRUNE_MS + 2); // third cycle still fires (not pruned)

    expect(client.listActiveRuns).toHaveBeenCalledTimes(3);
    r.stop();
  });
});
