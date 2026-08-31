import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import { Router, selectTier } from '../router.js';
import { JobQueue } from '../queue.js';
import { WorkerPool } from '../worker-pool.js';
import { ExecutionTier } from '../../types/index.js';
import type { Job, WorkerRegistration } from '../../types/index.js';

function makeJob(id: string, labels = ['linux'], tier = ExecutionTier.Standard): Job {
  return { id, owner: 'org', repo: 'repo', runId: 1, labels, tier, queuedAt: new Date(), runnerToken: 't' };
}

function worker(workerId: string, capabilities = ['linux']): WorkerRegistration {
  return { workerId, instanceId: workerId, region: 'us-east-1', availabilityZone: 'a', totalSlots: 4, totalVcpus: 16, totalMemoryMiB: 32_768, capabilities };
}

function mockStream() {
  const written: string[] = [];
  return {
    writable: true,
    writableEnded: false,
    written,
    write: (data: string) => { written.push(data); return true; },
  } as unknown as ServerResponse & { written: string[] };
}

describe('selectTier', () => {
  it('returns Standard for generic self-hosted labels', () => {
    expect(selectTier(['self-hosted', 'linux'])).toBe(ExecutionTier.Standard);
  });

  it('returns Critical for the burstgrid:critical label', () => {
    expect(selectTier(['linux', 'burstgrid:critical'])).toBe(ExecutionTier.Critical);
  });

  it('returns HighDensity for the burstgrid:high-density label', () => {
    expect(selectTier(['burstgrid:high-density', 'linux'])).toBe(ExecutionTier.HighDensity);
  });

  it('is case-insensitive', () => {
    expect(selectTier(['BURSTGRID:CRITICAL'])).toBe(ExecutionTier.Critical);
    expect(selectTier(['BURSTGRID:HIGH-DENSITY'])).toBe(ExecutionTier.HighDensity);
  });

  it('returns GpuAI for the burstgrid:gpu label', () => {
    expect(selectTier(['linux', 'burstgrid:gpu'])).toBe(ExecutionTier.GpuAI);
  });

  it('returns GpuAI for the burstgrid:gpu-ai label', () => {
    expect(selectTier(['linux', 'burstgrid:gpu-ai'])).toBe(ExecutionTier.GpuAI);
  });

  it('is case-insensitive for GPU labels', () => {
    expect(selectTier(['BURSTGRID:GPU'])).toBe(ExecutionTier.GpuAI);
    expect(selectTier(['BURSTGRID:GPU-AI'])).toBe(ExecutionTier.GpuAI);
  });

  it('critical takes precedence when multiple tier labels are present', () => {
    expect(selectTier(['burstgrid:critical', 'burstgrid:high-density'])).toBe(ExecutionTier.Critical);
  });
});

describe('Router dispatch', () => {
  let queue: JobQueue;
  let pool: WorkerPool;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new JobQueue();
    pool = new WorkerPool();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches synchronously when a worker stream is active at enqueue time', () => {
    new Router(queue, pool);
    pool.register(worker('w1'));
    const stream = mockStream();
    pool.setStream('w1', stream as any);

    queue.enqueue(makeJob('job-1'));

    expect(stream.written).toHaveLength(1);
    expect(JSON.parse(stream.written[0].slice(6))).toMatchObject({ jobId: 'job-1' });
    expect(queue.depth).toBe(0);
  });

  it('requeues when no worker has an active stream', () => {
    new Router(queue, pool);
    pool.register(worker('w1'));
    queue.enqueue(makeJob('job-1'));
    expect(queue.depth).toBe(1);
  });

  it('dispatches on the periodic tick after a stream connects post-enqueue', () => {
    new Router(queue, pool);
    pool.register(worker('w1'));

    queue.enqueue(makeJob('job-1'));
    expect(queue.depth).toBe(1);

    const stream = mockStream();
    pool.setStream('w1', stream as any);
    vi.advanceTimersByTime(600); // past the 500ms drain interval

    expect(stream.written).toHaveLength(1);
    expect(queue.depth).toBe(0);
  });

  it('drains multiple jobs to different workers in one pass', () => {
    new Router(queue, pool);
    pool.register(worker('w1'));
    pool.register(worker('w2'));
    const s1 = mockStream();
    const s2 = mockStream();
    pool.setStream('w1', s1 as any);
    pool.setStream('w2', s2 as any);

    queue.enqueue(makeJob('job-1'));
    queue.enqueue(makeJob('job-2'));

    const dispatched = new Set([
      ...s1.written.map(d => JSON.parse(d.slice(6)).jobId),
      ...s2.written.map(d => JSON.parse(d.slice(6)).jobId),
    ]);
    expect(dispatched).toEqual(new Set(['job-1', 'job-2']));
  });

  it('does not dispatch a critical job to a worker missing the critical capability', () => {
    new Router(queue, pool);
    pool.register({ ...worker('w1'), capabilities: ['linux'] });
    pool.setStream('w1', mockStream() as any);

    queue.enqueue(makeJob('job-critical', ['linux', 'burstgrid:critical'], ExecutionTier.Critical));
    expect(queue.depth).toBe(1);
  });

  it('emits a stale-job warning when a job has been queued >10 min with no capable workers', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Router(queue, pool);
    // No workers registered — canAnyWorkerEverHandle returns false

    queue.enqueue(makeJob('job-stale', ['linux']));

    // Advance past the 10-min stale threshold; the 500ms drain interval will fire and warn
    vi.advanceTimersByTime(10 * 60_000 + 501);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('job-stale'));
    warnSpy.mockRestore();
  });
});

describe('Router — per-repo concurrency limits', () => {
  let queue: JobQueue;
  let pool: WorkerPool;
  let router: Router;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new JobQueue();
    pool  = new WorkerPool();
    router = new Router(queue, pool);
  });

  afterEach(() => {
    router.stop();
    vi.useRealTimers();
  });

  it('limitFor returns repo-specific limit ahead of org wildcard and default', () => {
    router.setConcurrencyLimits({ 'org/*': 10, 'org/repo': 2 }, 5);
    // Cast to access private method for white-box testing
    const lf = (router as unknown as { limitFor(o: string, r: string): number | undefined }).limitFor;
    expect(lf.call(router, 'org', 'repo')).toBe(2);      // repo-specific wins
    expect(lf.call(router, 'org', 'other')).toBe(10);    // org wildcard
    expect(lf.call(router, 'acme', 'x')).toBe(5);        // global default
  });

  it('holds the 2nd job when defaultRepoConcurrency=1 and 1 job already running', async () => {
    router.setConcurrencyLimits({}, 1);

    pool.register(worker('w1'));
    pool.setStream('w1', mockStream());

    // Seed one running job so runningJobsFor('org','repo') = 1
    pool.trackJob('w1', makeJob('job-existing'));

    // Enqueue a second job — limit is 1, running = 1, should be held
    queue.enqueue(makeJob('job-held'));
    // Advance just past the 500ms drain interval (not past the 30s stale timeout)
    await vi.advanceTimersByTimeAsync(600);

    // job-held must still be in the queue (enqueueSkipped puts it back)
    expect(pool.runningJobsFor('org', 'repo')).toBe(1); // still only 1 running
  });

  it('dispatches held job once running count drops below limit', async () => {
    router.setConcurrencyLimits({}, 1);

    pool.register(worker('w1'));
    const stream = mockStream();
    pool.setStream('w1', stream);

    // Seed one running job
    pool.trackJob('w1', makeJob('job-a'));

    // Enqueue held job — should not dispatch yet
    queue.enqueue(makeJob('job-b'));
    await vi.advanceTimersByTimeAsync(600);
    const countBefore = stream.written.length;

    // Release job-a; the 500 ms drain timer will fire and dispatch job-b
    pool.releaseJob('w1', 'job-a');
    await vi.advanceTimersByTimeAsync(600);

    expect(stream.written.length).toBeGreaterThan(countBefore);
  });

  it('org/* wildcard applies per-repo (each repo gets its own cap)', () => {
    router.setConcurrencyLimits({ 'org/*': 2 });
    const lf = (router as unknown as { limitFor(o: string, r: string): number | undefined }).limitFor;
    // Every repo under org gets cap 2
    expect(lf.call(router, 'org', 'repo-a')).toBe(2);
    expect(lf.call(router, 'org', 'repo-b')).toBe(2);
    // Different org is uncapped
    expect(lf.call(router, 'other', 'repo-a')).toBeUndefined();
  });
});
