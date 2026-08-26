import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobQueue } from '../queue.js';
import { ExecutionTier } from '../../types/index.js';
import type { Job } from '../../types/index.js';

function makeJob(tier: ExecutionTier, id: string = crypto.randomUUID()): Job {
  return { id, owner: 'org', repo: 'repo', runId: 1, labels: [], tier, queuedAt: new Date(), runnerToken: 't' };
}

describe('JobQueue', () => {
  let queue: JobQueue;

  beforeEach(() => { queue = new JobQueue(); });

  it('dequeues in tier priority order regardless of enqueue order', () => {
    const standard = makeJob(ExecutionTier.Standard, 'standard');
    const critical = makeJob(ExecutionTier.Critical, 'critical');
    const overflow = makeJob(ExecutionTier.Overflow, 'overflow');
    const highDensity = makeJob(ExecutionTier.HighDensity, 'hd');
    const gpuAi = makeJob(ExecutionTier.GpuAI, 'gpu');

    queue.enqueue(overflow);
    queue.enqueue(highDensity);
    queue.enqueue(gpuAi);
    queue.enqueue(standard);
    queue.enqueue(critical);

    expect(queue.dequeue()?.id).toBe('critical');
    expect(queue.dequeue()?.id).toBe('standard');
    expect(queue.dequeue()?.id).toBe('gpu');
    expect(queue.dequeue()?.id).toBe('hd');
    expect(queue.dequeue()?.id).toBe('overflow');
  });

  it('GpuAI jobs enqueue and dequeue without error', () => {
    const gpu = makeJob(ExecutionTier.GpuAI, 'gpu-job');
    queue.enqueue(gpu);
    expect(queue.depth).toBe(1);
    expect(queue.dequeue()?.id).toBe('gpu-job');
  });

  it('returns undefined when empty', () => {
    expect(queue.dequeue()).toBeUndefined();
  });

  it('FIFO within the same tier', () => {
    const a = makeJob(ExecutionTier.Standard, 'a');
    const b = makeJob(ExecutionTier.Standard, 'b');
    queue.enqueue(a);
    queue.enqueue(b);
    expect(queue.dequeue()?.id).toBe('a');
    expect(queue.dequeue()?.id).toBe('b');
  });

  it('requeue places job at the front of its tier', () => {
    const a = makeJob(ExecutionTier.Standard, 'a');
    const b = makeJob(ExecutionTier.Standard, 'b');
    queue.enqueue(a);
    queue.enqueue(b);
    queue.dequeue(); // remove a
    queue.requeue(a);
    // a was requeued ahead of b
    expect(queue.dequeue()?.id).toBe('a');
    expect(queue.dequeue()?.id).toBe('b');
  });

  it('depth counts across all tiers', () => {
    queue.enqueue(makeJob(ExecutionTier.Critical));
    queue.enqueue(makeJob(ExecutionTier.Standard));
    queue.enqueue(makeJob(ExecutionTier.Overflow));
    expect(queue.depth).toBe(3);
    queue.dequeue();
    expect(queue.depth).toBe(2);
  });

  it('emits job event on each enqueue', () => {
    const spy = vi.fn();
    queue.on('job', spy);
    queue.enqueue(makeJob(ExecutionTier.Standard));
    queue.enqueue(makeJob(ExecutionTier.Critical));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('depth is zero after draining all tiers', () => {
    queue.enqueue(makeJob(ExecutionTier.Critical));
    queue.enqueue(makeJob(ExecutionTier.Standard));
    queue.dequeue();
    queue.dequeue();
    expect(queue.depth).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });
});
