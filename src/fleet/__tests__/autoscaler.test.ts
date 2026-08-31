import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Autoscaler, type TierFleet } from '../autoscaler.js';
import { WorkerPool } from '../../scheduler/worker-pool.js';
import { JobQueue } from '../../scheduler/queue.js';
import { ExecutionTier } from '../../types/index.js';
import type { Job } from '../../types/index.js';

vi.mock('@aws-sdk/client-ec2', () => {
  const send = vi.fn().mockResolvedValue({ Instances: [{ InstanceId: 'i-test' }] });
  class EC2Client { send = send; }
  class RunInstancesCommand {}
  class TerminateInstancesCommand { constructor(public input: unknown) {} }
  return { EC2Client, RunInstancesCommand, TerminateInstancesCommand };
});

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

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

describe('Autoscaler bin-packing scale-up', () => {
  afterEach(() => vi.useRealTimers());

  it('uses largest fleet first to minimise instance count', async () => {
    vi.useFakeTimers();
    const { EC2Client } = await import('@aws-sdk/client-ec2');
    const sendMock = vi.mocked((new EC2Client() as unknown as { send: ReturnType<typeof vi.fn> }).send);

    const pool = new WorkerPool();
    // 10 pending large jobs × 4 vCPU = 40 vCPU demand
    const q = new JobQueue();
    for (let i = 0; i < 10; i++) {
      q.enqueue({ id: `j-${i}`, owner: 'o', repo: 'r', runId: i, labels: ['burstgrid:size=large'],
        tier: ExecutionTier.Standard, queuedAt: new Date(), runnerToken: 't' } as Job);
    }

    const smallFleet: TierFleet = { ...FLEET, name: 'small', maxWorkers: 10, slotsPerWorker: 2, instanceVcpus: 4 };
    const largeFleet: TierFleet = { ...FLEET, name: 'large', maxWorkers: 5,  slotsPerWorker: 4, instanceVcpus: 16 };

    const autoscaler = new Autoscaler(pool, q, [smallFleet, largeFleet], 30_000);
    await (autoscaler as unknown as { evaluate(): Promise<void> }).evaluate();

    const launchCalls = sendMock.mock.calls.filter(
      ([cmd]) => (cmd as { constructor: { name: string } }).constructor.name === 'RunInstancesCommand',
    );
    // 40 vCPU deficit / 16 vCPU per large instance = ceil(40/16) = 3 (not 10 small instances)
    expect(launchCalls).toHaveLength(3);

    autoscaler.stop();
  });

  it('falls back to smaller fleet when large fleet hits maxWorkers', async () => {
    vi.useFakeTimers();
    const { EC2Client } = await import('@aws-sdk/client-ec2');
    const sendMock = vi.mocked((new EC2Client() as unknown as { send: ReturnType<typeof vi.fn> }).send);

    const pool = new WorkerPool();
    // 32 vCPU demand
    const q = new JobQueue();
    for (let i = 0; i < 8; i++) {
      q.enqueue({ id: `j-${i}`, owner: 'o', repo: 'r', runId: i, labels: ['burstgrid:size=large'],
        tier: ExecutionTier.Standard, queuedAt: new Date(), runnerToken: 't' } as Job);
    }

    const largeFleet: TierFleet = { ...FLEET, name: 'large', maxWorkers: 1, slotsPerWorker: 4, instanceVcpus: 16 };
    const smallFleet: TierFleet = { ...FLEET, name: 'small', maxWorkers: 5, slotsPerWorker: 2, instanceVcpus: 4 };

    const autoscaler = new Autoscaler(pool, q, [largeFleet, smallFleet], 30_000);
    await (autoscaler as unknown as { evaluate(): Promise<void> }).evaluate();

    const launchCalls = sendMock.mock.calls.filter(
      ([cmd]) => (cmd as { constructor: { name: string } }).constructor.name === 'RunInstancesCommand',
    );
    // 1 large (16 vCPU, capped at maxWorkers=1) + ceil(16 remaining / 4 vCPU) = 4 small = 5 total
    expect(launchCalls).toHaveLength(5);

    autoscaler.stop();
  });
});

describe('Autoscaler scale-down', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('terminates idle workers that have exceeded scaleDownAfterIdleSec', async () => {
    const { EC2Client } = await import('@aws-sdk/client-ec2');
    const sendMock = vi.mocked((new EC2Client() as unknown as { send: ReturnType<typeof vi.fn> }).send);

    const pool = new WorkerPool();
    pool.register({ workerId: 'w1', instanceId: 'w1', ec2InstanceId: 'i-idle001',
      region: 'us-east-1', availabilityZone: 'a', totalSlots: 4, totalVcpus: 8, totalMemoryMiB: 16_384, capabilities: [''] });
    pool.register({ workerId: 'w2', instanceId: 'w2', ec2InstanceId: 'i-idle002',
      region: 'us-east-1', availabilityZone: 'a', totalSlots: 4, totalVcpus: 8, totalMemoryMiB: 16_384, capabilities: [''] });
    const stream = { writable: true, writableEnded: false, write: vi.fn() } as unknown as import('node:http').ServerResponse;
    pool.setStream('w1', stream);
    pool.setStream('w2', stream);

    vi.advanceTimersByTime(2_000); // 2 s > 1 s threshold, well within 30 s stale window

    const queue = new JobQueue(); // empty — no jobs
    const fleet = { ...FLEET, maxWorkers: 3, scaleDownAfterIdleSec: 1, minIdleWorkers: 1 };
    const autoscaler = new Autoscaler(pool, queue, [fleet], 30_000);
    await (autoscaler as unknown as { evaluate(): Promise<void> }).evaluate();

    const terminateCalls = sendMock.mock.calls.filter(
      ([cmd]) => (cmd as { constructor: { name: string } }).constructor.name === 'TerminateInstancesCommand',
    );
    expect(terminateCalls).toHaveLength(1);
    // One worker kept alive as the warm standby, one terminated
    const terminated = (terminateCalls[0][0] as { input: { InstanceIds: string[] } }).input.InstanceIds;
    expect(terminated).toHaveLength(1);

    autoscaler.stop();
  });

  it('keeps exactly 1 warm standby when 3 workers are all idle', async () => {
    const { EC2Client } = await import('@aws-sdk/client-ec2');
    const sendMock = vi.mocked((new EC2Client() as unknown as { send: ReturnType<typeof vi.fn> }).send);

    const pool = new WorkerPool();
    const stream = { writable: true, writableEnded: false, write: vi.fn() } as unknown as import('node:http').ServerResponse;
    for (const id of ['w1', 'w2', 'w3']) {
      pool.register({ workerId: id, instanceId: id, ec2InstanceId: `i-00${id}`,
        region: 'us-east-1', availabilityZone: 'a', totalSlots: 4, totalVcpus: 8, totalMemoryMiB: 16_384, capabilities: [''] });
      pool.setStream(id, stream);
    }

    vi.advanceTimersByTime(2_000);

    const queue = new JobQueue();
    const fleet = { ...FLEET, maxWorkers: 5, scaleDownAfterIdleSec: 1, minIdleWorkers: 1 };
    const autoscaler = new Autoscaler(pool, queue, [fleet], 30_000);
    await (autoscaler as unknown as { evaluate(): Promise<void> }).evaluate();

    const terminated = sendMock.mock.calls.filter(
      ([cmd]) => (cmd as { constructor: { name: string } }).constructor.name === 'TerminateInstancesCommand',
    ).flatMap(([cmd]) => (cmd as { input: { InstanceIds: string[] } }).input.InstanceIds);
    expect(terminated).toHaveLength(2); // 3 idle workers → terminate 2, keep 1 warm standby

    autoscaler.stop();
  });

  it('does not terminate workers that are not yet idle long enough', async () => {
    const { EC2Client } = await import('@aws-sdk/client-ec2');
    const sendMock = vi.mocked((new EC2Client() as unknown as { send: ReturnType<typeof vi.fn> }).send);

    const pool = new WorkerPool();
    pool.register({ workerId: 'w1', instanceId: 'w1', ec2InstanceId: 'i-recent',
      region: 'us-east-1', availabilityZone: 'a', totalSlots: 4, totalVcpus: 8, totalMemoryMiB: 16_384, capabilities: [''] });
    pool.setStream('w1', { writable: true, writableEnded: false, write: vi.fn() } as unknown as import('node:http').ServerResponse);

    // No time advance — idle for 0 ms, threshold is 5 min

    const queue = new JobQueue();
    const fleet = { ...FLEET, scaleDownAfterIdleSec: 300 };
    const autoscaler = new Autoscaler(pool, queue, [fleet], 30_000);
    await (autoscaler as unknown as { evaluate(): Promise<void> }).evaluate();

    const terminateCalls = sendMock.mock.calls.filter(
      ([cmd]) => (cmd as { constructor: { name: string } }).constructor.name === 'TerminateInstancesCommand',
    );
    expect(terminateCalls).toHaveLength(0);

    autoscaler.stop();
  });
});
