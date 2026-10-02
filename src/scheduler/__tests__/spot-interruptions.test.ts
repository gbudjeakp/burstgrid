import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { SpotInterruptionMonitor } from '../spot-interruptions.js';
import { WorkerPool } from '../worker-pool.js';
import { JobQueue } from '../queue.js';
import { ExecutionTier, type Job } from '../../types/index.js';

vi.mock('@aws-sdk/client-sqs', () => {
  class SQSClient { send = vi.fn(); }
  class ReceiveMessageCommand { constructor(public input: unknown) {} }
  class DeleteMessageCommand { constructor(public input: unknown) {} }
  return { SQSClient, ReceiveMessageCommand, DeleteMessageCommand };
});

vi.mock('../../telemetry/index.js', () => ({ logEvent: vi.fn() }));

function mockStream() {
  return { writable: true, writableEnded: false, write: vi.fn() } as unknown as ServerResponse;
}

function job(id: string): Job {
  return { id, owner: 'org', repo: 'repo', runId: 1, labels: ['linux'], tier: ExecutionTier.Standard, queuedAt: new Date(), runnerToken: 't' };
}

describe('SpotInterruptionMonitor', () => {
  it('requeues jobs from the worker running on the interrupted EC2 instance', () => {
    const pool = new WorkerPool();
    const queue = new JobQueue();
    pool.register({
      workerId: 'worker-1',
      instanceId: 'worker-1',
      ec2InstanceId: 'i-spot123',
      region: 'us-east-1',
      availabilityZone: 'us-east-1a',
      totalSlots: 4,
      totalVcpus: 8,
      totalMemoryMiB: 16_384,
      capabilities: ['linux'],
    });
    pool.setStream('worker-1', mockStream());
    pool.trackJob('worker-1', job('job-a'));
    pool.trackJob('worker-1', job('job-b'));

    const monitor = new SpotInterruptionMonitor('https://sqs.us-east-1.amazonaws.com/123/spot', pool, queue);
    (monitor as unknown as { handleMessage(body: string): void }).handleMessage(JSON.stringify({
      'detail-type': 'EC2 Spot Instance Interruption Warning',
      time: '2026-09-21T10:00:00Z',
      detail: { 'instance-id': 'i-spot123' },
    }));

    expect(queue.depth).toBe(2);
    expect(pool.hasWorker('worker-1')).toBe(false);
  });

  it('leaves the queue unchanged for an unknown interrupted instance', () => {
    const pool = new WorkerPool();
    const queue = new JobQueue();
    const monitor = new SpotInterruptionMonitor('https://sqs.us-east-1.amazonaws.com/123/spot', pool, queue);

    (monitor as unknown as { handleMessage(body: string): void }).handleMessage(JSON.stringify({
      'detail-type': 'EC2 Spot Instance Interruption Warning',
      detail: { 'instance-id': 'i-missing' },
    }));

    expect(queue.depth).toBe(0);
  });
});
