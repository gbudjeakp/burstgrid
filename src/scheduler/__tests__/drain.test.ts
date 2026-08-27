import { describe, it, expect } from 'vitest';
import { JobQueue } from '../queue.js';
import { JobMetaCache } from '../job-meta-cache.js';
import { awaitDrain } from '../drain.js';
import { ExecutionTier } from '../../types/index.js';
import type { Job } from '../../types/index.js';

function makeJob(): Job {
  return { id: crypto.randomUUID(), owner: 'org', repo: 'repo', runId: 1, labels: [], tier: ExecutionTier.Standard, queuedAt: new Date(), runnerToken: 't' };
}
const META = { owner: 'acme', repo: 'api', runId: 1, tier: ExecutionTier.Standard, labels: [] };

describe('awaitDrain', () => {
  it('resolves immediately when both queue and cache are already empty', async () => {
    const queue = new JobQueue();
    const cache = new JobMetaCache();
    await expect(awaitDrain(queue, cache)).resolves.toBeUndefined();
    cache.destroy();
  });

  it('resolves after the queue drains (one job dispatched)', async () => {
    const queue = new JobQueue();
    const cache = new JobMetaCache();
    queue.enqueue(makeJob());

    const p = awaitDrain(queue, cache);
    queue.dequeue();

    await expect(p).resolves.toBeUndefined();
    cache.destroy();
  });

  it('resolves after the cache drains (one in-flight job completes)', async () => {
    const queue = new JobQueue();
    const cache = new JobMetaCache();
    cache.set('job-1', META);

    const p = awaitDrain(queue, cache);
    cache.delete('job-1');

    await expect(p).resolves.toBeUndefined();
    cache.destroy();
  });

  it('does not resolve until both queue and cache are empty', async () => {
    const queue = new JobQueue();
    const cache = new JobMetaCache();
    queue.enqueue(makeJob());
    cache.set('job-1', META);

    const p = awaitDrain(queue, cache);
    let resolved = false;
    void p.then(() => { resolved = true; });

    queue.dequeue();
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false); // cache still has an entry

    cache.delete('job-1');
    await expect(p).resolves.toBeUndefined();
    cache.destroy();
  });

  it('resolves after multiple queue items are fully dequeued', async () => {
    const queue = new JobQueue();
    const cache = new JobMetaCache();
    queue.enqueue(makeJob());
    queue.enqueue(makeJob());

    const p = awaitDrain(queue, cache);
    let resolved = false;
    void p.then(() => { resolved = true; });

    queue.dequeue();
    await Promise.resolve();
    expect(resolved).toBe(false); // one item remains

    queue.dequeue();
    await expect(p).resolves.toBeUndefined();
    cache.destroy();
  });
});
