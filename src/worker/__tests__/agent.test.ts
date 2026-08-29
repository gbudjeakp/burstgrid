import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerAgent, type AgentConfig } from '../agent.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  captured: [] as { slotIndex: number | undefined }[],
  nextFails: false,
}));

vi.mock('../slot.js', () => ({
  Slot: vi.fn(function (cfg: { slotIndex?: number }) {
    state.captured.push({ slotIndex: cfg.slotIndex });
    const fail = state.nextFails;
    state.nextFails = false;
    return {
      start:   fail ? vi.fn().mockRejectedValue(new Error('runner exited 1'))
                    : vi.fn().mockResolvedValue(undefined),
      wait:    vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(maxSlots: number) {
  const cfg: AgentConfig = {
    schedulerUrl: 'http://localhost:8080',
    workerId: 'w1',
    maxSlots,
    totalVcpus: 4,
    totalMemoryMiB: 4096,
    capabilities: [],
    vmImagePath: '/img',
    kernelPath: '/k',
    mode: 'process',
  };
  return new WorkerAgent(cfg);
}

function makeJob(jobId: string) {
  return {
    jobId,
    owner: 'owner',
    repo: 'repo',
    runId: 1,
    runnerToken: 'tok',
    labels: ['self-hosted'],
    tier: 'standard' as const,
    vcpus: 2,
    memoryMiB: 2048,
  };
}

function freeIndices(agent: WorkerAgent): number[] {
  return (agent as unknown as { freeSlotIndices: number[] }).freeSlotIndices;
}

function callRunJob(agent: WorkerAgent, job: ReturnType<typeof makeJob>) {
  vi.spyOn(agent as never, 'reportStatus').mockResolvedValue(undefined);
  return (agent as unknown as { runJob(j: typeof job): Promise<void> }).runJob(job);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkerAgent — slot index pool', () => {
  beforeEach(() => {
    state.captured.length = 0;
    state.nextFails = false;
    vi.clearAllMocks();
  });

  it('initialises freeSlotIndices with 0..maxSlots-1', () => {
    const agent = makeAgent(4);
    expect(new Set(freeIndices(agent))).toEqual(new Set([0, 1, 2, 3]));
  });

  it('passes a unique slotIndex to each concurrent Slot', async () => {
    const agent = makeAgent(3);
    await Promise.all([
      callRunJob(agent, makeJob('j1')),
      callRunJob(agent, makeJob('j2')),
      callRunJob(agent, makeJob('j3')),
    ]);
    expect(new Set(state.captured.map(c => c.slotIndex))).toEqual(new Set([0, 1, 2]));
  });

  it('returns a slot index to the pool after the job completes', async () => {
    const agent = makeAgent(2);
    await callRunJob(agent, makeJob('j1'));
    expect(freeIndices(agent)).toHaveLength(2);
  });

  it('returns the slot index even when the job fails', async () => {
    state.nextFails = true;
    const agent = makeAgent(2);
    await callRunJob(agent, makeJob('j-fail')).catch(() => {});
    expect(freeIndices(agent)).toHaveLength(2);
  });

  it('two sequential jobs can reuse the same slot index', async () => {
    const agent = makeAgent(1);
    await callRunJob(agent, makeJob('j1'));
    await callRunJob(agent, makeJob('j2'));
    expect(state.captured[0]?.slotIndex).toBe(state.captured[1]?.slotIndex);
  });
});

