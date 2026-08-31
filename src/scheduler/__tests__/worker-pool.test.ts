import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import { WorkerPool } from '../worker-pool.js';
import { ExecutionTier } from '../../types/index.js';
import type { WorkerRegistration, JobAssignment, Job } from '../../types/index.js';

function reg(workerId: string, totalSlots = 4, capabilities = ['linux']): WorkerRegistration {
  return { workerId, instanceId: workerId, region: 'us-east-1', availabilityZone: 'a', totalSlots, totalVcpus: 8, totalMemoryMiB: 16_384, capabilities };
}

function assignment(jobId: string): JobAssignment {
  return { jobId, owner: 'org', repo: 'repo', runId: 1, runnerToken: 't', labels: ['linux'], tier: ExecutionTier.Standard, vcpus: 2, memoryMiB: 2_048 };
}

function job(id: string): Job {
  return { id, owner: 'org', repo: 'repo', runId: 1, labels: ['linux'], tier: ExecutionTier.Standard, queuedAt: new Date(), runnerToken: 't' };
}

function mockStream(writable = true) {
  const written: string[] = [];
  return {
    writable,
    writableEnded: !writable,
    written,
    write: vi.fn((data: string) => { written.push(data); return true; }),
  } as unknown as ServerResponse & { written: string[] };
}

describe('WorkerPool', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    vi.useFakeTimers();
    pool = new WorkerPool();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('assign', () => {
    it('writes an SSE data event to the worker stream', () => {
      pool.register(reg('w1'));
      const stream = mockStream();
      pool.setStream('w1', stream);

      const ok = pool.assign('w1', assignment('job-1'));

      expect(ok).toBe(true);
      expect(stream.write).toHaveBeenCalledOnce();
      expect(stream.written[0]).toMatch(/^data: \{.*"jobId":"job-1".*\}\n\n$/);
    });

    it('returns false when no stream is connected', () => {
      pool.register(reg('w1'));
      expect(pool.assign('w1', assignment('job-1'))).toBe(false);
    });

    it('returns false when the stream is no longer writable', () => {
      pool.register(reg('w1'));
      pool.setStream('w1', mockStream(false));
      expect(pool.assign('w1', assignment('job-1'))).toBe(false);
    });

    it('returns false when the worker lacks free resources for the job', () => {
      pool.register(reg('w1', 4));
      pool.setStream('w1', mockStream());
      // Exhaust vCPU by assigning a job that uses all 8 vCPUs
      pool.assign('w1', { ...assignment('big'), vcpus: 8, memoryMiB: 2_048 });
      expect(pool.assign('w1', assignment('job-2'))).toBe(false);
    });

    it('returns false for an unregistered worker', () => {
      expect(pool.assign('ghost', assignment('job-1'))).toBe(false);
    });

    it('decrements freeSlots on successful assign', () => {
      pool.register(reg('w1', 4));
      pool.setStream('w1', mockStream());
      pool.assign('w1', assignment('job-1'));
      expect(pool.totalFreeSlots).toBe(3);
    });

    it('preserves the existing stream across re-registration', () => {
      pool.register(reg('w1'));
      const stream = mockStream();
      pool.setStream('w1', stream);
      pool.register(reg('w1')); // re-register (e.g. after scheduler restart)
      pool.assign('w1', assignment('job-1'));
      expect(stream.written).toHaveLength(1);
    });
  });

  describe('bestWorker', () => {
    it('selects the worker with the most free slots', () => {
      pool.register(reg('w1', 2));
      pool.register(reg('w2', 8));
      pool.setStream('w1', mockStream());
      pool.setStream('w2', mockStream());
      expect(pool.bestWorker(['linux'], 2, 2_048)).toBe('w2');
    });

    it('excludes workers without a connected stream', () => {
      pool.register(reg('w1', 4));
      expect(pool.bestWorker(['linux'], 2, 2_048)).toBeNull();
    });

    it('excludes workers with a closed stream', () => {
      pool.register(reg('w1', 4));
      pool.setStream('w1', mockStream(false));
      expect(pool.bestWorker(['linux'], 2, 2_048)).toBeNull();
    });

    it('requires all capability labels to match', () => {
      pool.register(reg('w1', 4, ['linux']));
      pool.setStream('w1', mockStream());
      expect(pool.bestWorker(['linux', 'gpu'], 2, 2_048)).toBeNull();
    });

    it('accepts a worker whose capabilities are a superset of required labels', () => {
      pool.register(reg('w1', 4, ['linux', 'docker', 'x86_64']));
      pool.setStream('w1', mockStream());
      expect(pool.bestWorker(['linux', 'docker'], 2, 2_048)).toBe('w1');
    });

    it('excludes workers without enough free vCPUs', () => {
      pool.register(reg('w1', 4));
      pool.setStream('w1', mockStream());
      // Consume all 8 vCPUs
      pool.assign('w1', { ...assignment('hog'), vcpus: 8, memoryMiB: 2_048 });
      expect(pool.bestWorker(['linux'], 4, 4_096)).toBeNull();
    });
  });

  describe('heartbeat', () => {
    it('updates freeSlots and free resource counters', () => {
      pool.register(reg('w1', 4));
      pool.heartbeat({ workerId: 'w1', freeSlots: 2, usedSlots: 2, freeVcpus: 4, freeMemoryMiB: 8_192 });
      expect(pool.totalFreeSlots).toBe(2);
    });

    it('is a no-op for unregistered workers', () => {
      expect(() => pool.heartbeat({ workerId: 'ghost', freeSlots: 1, usedSlots: 0, freeVcpus: 1, freeMemoryMiB: 1024 })).not.toThrow();
    });
  });

  describe('metrics', () => {
    it('connectedCount counts only workers with a writable stream', () => {
      pool.register(reg('w1'));
      pool.register(reg('w2'));
      pool.setStream('w1', mockStream());
      pool.setStream('w2', mockStream(false));
      expect(pool.connectedCount).toBe(1);
    });

    it('totalFreeSlots sums across all workers regardless of stream state', () => {
      pool.register(reg('w1', 4));
      pool.register(reg('w2', 8));
      expect(pool.totalFreeSlots).toBe(12);
    });
  });

  describe('job tracking', () => {
    it('trackJob records a job for a worker; drainWorkerJobs returns and clears it', () => {
      pool.register(reg('w1'));
      const j = job('job-1');
      pool.trackJob('w1', j);

      const drained = pool.drainWorkerJobs('w1');
      expect(drained).toHaveLength(1);
      expect(drained[0].id).toBe('job-1');

      // drainWorkerJobs clears the entry
      expect(pool.drainWorkerJobs('w1')).toHaveLength(0);
    });

    it('releaseJob removes a specific job without affecting others', () => {
      pool.register(reg('w1'));
      pool.trackJob('w1', job('job-a'));
      pool.trackJob('w1', job('job-b'));

      pool.releaseJob('w1', 'job-a');

      const drained = pool.drainWorkerJobs('w1');
      expect(drained).toHaveLength(1);
      expect(drained[0].id).toBe('job-b');
    });

    it('releaseJob on unknown workerId is a no-op', () => {
      expect(() => pool.releaseJob('ghost', 'job-x')).not.toThrow();
    });

    it('unregister clears tracked jobs for that worker', () => {
      pool.register(reg('w1'));
      pool.trackJob('w1', job('job-1'));
      pool.unregister('w1');

      expect(pool.drainWorkerJobs('w1')).toHaveLength(0);
    });
  });

  describe('idleWorkers', () => {
    it('returns workers idle longer than the threshold that have an ec2InstanceId', () => {
      const pool2 = new WorkerPool();
      const stream = mockStream();
      pool2.register({ ...reg('w1'), ec2InstanceId: 'i-abc123' });
      pool2.setStream('w1', stream);

      vi.advanceTimersByTime(2_000); // 2 s > 1 s threshold
      expect(pool2.idleWorkers('linux', 1_000)).toEqual([{ workerId: 'w1', ec2InstanceId: 'i-abc123' }]);
    });

    it('excludes workers that are not yet idle long enough', () => {
      const pool2 = new WorkerPool();
      pool2.register({ ...reg('w1'), ec2InstanceId: 'i-abc123' });
      pool2.setStream('w1', mockStream());

      // No time advance — idleSince is at most 0 ms ago
      expect(pool2.idleWorkers('linux', 1_000)).toHaveLength(0);
    });

    it('excludes workers without an ec2InstanceId', () => {
      const pool2 = new WorkerPool();
      pool2.register(reg('w1')); // no ec2InstanceId
      pool2.setStream('w1', mockStream());

      vi.advanceTimersByTime(2_000);
      expect(pool2.idleWorkers('linux', 1_000)).toHaveLength(0);
    });

    it('resets idleSince when a job is assigned and restarts it on releaseJob', () => {
      const pool2 = new WorkerPool();
      pool2.register({ ...reg('w1'), ec2InstanceId: 'i-abc123' });
      pool2.setStream('w1', mockStream());
      const j = job('j1');
      pool2.trackJob('w1', j);
      pool2.assign('w1', assignment('j1'));

      vi.advanceTimersByTime(2_000); // time passes but worker is busy
      expect(pool2.idleWorkers('linux', 1_000)).toHaveLength(0);

      pool2.releaseJob('w1', 'j1');
      vi.advanceTimersByTime(2_000); // 2 s after job completes
      expect(pool2.idleWorkers('linux', 1_000)).toHaveLength(1);
    });
  });

  describe('reapStale', () => {
    it('returns inflight jobs from reaped workers', () => {
      pool.register(reg('w1'));
      pool.trackJob('w1', job('job-lost'));
      // Advance past the 120 s stale timeout so the worker is eligible for reaping
      vi.advanceTimersByTime(121_000);

      const lost = pool.reapStale();
      expect(lost).toHaveLength(1);
      expect(lost[0].id).toBe('job-lost');
    });

    it('does not reap workers that are still within the stale window', () => {
      pool.register(reg('w1'));
      pool.trackJob('w1', job('job-active'));
      vi.advanceTimersByTime(15_000);

      const lost = pool.reapStale();
      expect(lost).toHaveLength(0);
    });

    it('fires onJobsLost callback with reaped jobs', () => {
      const onJobsLost = vi.fn();
      const p = new WorkerPool(onJobsLost);
      p.register(reg('w1'));
      p.trackJob('w1', job('job-cb'));
      vi.advanceTimersByTime(121_000);

      // The internal reap timer fires every 15 s; advance it
      vi.advanceTimersByTime(15_000);

      expect(onJobsLost).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ id: 'job-cb' }),
      ]));
    });
  });
});
