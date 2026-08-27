import { describe, it, expect, vi, afterEach } from 'vitest';
import { Autoscaler, type TierFleet } from '../autoscaler.js';
import { WorkerPool } from '../../scheduler/worker-pool.js';
import { JobQueue } from '../../scheduler/queue.js';
import { ExecutionTier } from '../../types/index.js';
import type { Job } from '../../types/index.js';

vi.mock('@aws-sdk/client-ec2', () => {
  const send = vi.fn().mockResolvedValue({ Instances: [{ InstanceId: 'i-test' }] });
  class EC2Client { send = send; }
  class RunInstancesCommand {}
  return { EC2Client, RunInstancesCommand };
});

afterEach(() => vi.restoreAllMocks());

const FLEET: TierFleet = {
  name: 'test', sizeTag: '', launchTemplateId: 'lt-123',
  subnetIds: ['subnet-a'], maxWorkers: 5, slotsPerWorker: 4, scaleUpThreshold: 0,
};

function makeQueue(depth: number): JobQueue {
  const q = new JobQueue();
  for (let i = 0; i < depth; i++) {
    q.enqueue({ id: `j-${i}`, owner: 'o', repo: 'r', runId: i, labels: [], tier: ExecutionTier.Standard, queuedAt: new Date(), runnerToken: 't' } as Job);
  }
  return q;
}

describe('Autoscaler pending launch guard', () => {
  it('counts pending launches against maxWorkers, preventing over-provision', async () => {
    vi.useFakeTimers();
    const pool = new WorkerPool();
    const queue = makeQueue(10); // enough jobs to want workers
    const autoscaler = new Autoscaler(pool, queue, [{ ...FLEET, maxWorkers: 2 }], 30_000);

    // First evaluation — 0 workers, 0 pending → should launch 2
    await (autoscaler as unknown as { evaluate(): Promise<void> }).evaluate();
    const pending1 = (autoscaler as unknown as { activePendingCount(n: string): number }).activePendingCount('test');
    expect(pending1).toBe(2);

    // Second evaluation — 0 registered, 2 pending → should NOT launch more
    await (autoscaler as unknown as { evaluate(): Promise<void> }).evaluate();
    const pending2 = (autoscaler as unknown as { activePendingCount(n: string): number }).activePendingCount('test');
    expect(pending2).toBe(2); // unchanged

    autoscaler.stop();
    vi.useRealTimers();
  });

  it('pending launches expire after LAUNCH_TTL_MS', async () => {
    vi.useFakeTimers();
    const pool = new WorkerPool();
    const queue = makeQueue(4);
    const autoscaler = new Autoscaler(pool, queue, [FLEET], 30_000);

    await (autoscaler as unknown as { evaluate(): Promise<void> }).evaluate();
    const beforeExpiry = (autoscaler as unknown as { activePendingCount(n: string): number }).activePendingCount('test');
    expect(beforeExpiry).toBeGreaterThan(0);

    // Advance past the 3-minute TTL
    vi.advanceTimersByTime(3 * 60 * 1_000 + 1);
    const afterExpiry = (autoscaler as unknown as { activePendingCount(n: string): number }).activePendingCount('test');
    expect(afterExpiry).toBe(0);

    autoscaler.stop();
    vi.useRealTimers();
  });
});
