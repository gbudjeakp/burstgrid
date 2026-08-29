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
  // Flush the microtask queue so fire-and-forget async calls complete
  await new Promise(resolve => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.clearAllMocks();
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
    vi.useRealTimers();
  });
});
