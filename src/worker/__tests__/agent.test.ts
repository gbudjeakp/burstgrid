import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerAgent, type AgentConfig } from '../agent.js';

// ─── Slot spy ─────────────────────────────────────────────────────────────────
// Capture every SlotConfig passed to new Slot() without executing real runner logic.

const capturedSlotConfigs: { slotIndex: number | undefined }[] = [];

vi.mock('../slot.js', () => ({
  Slot: vi.fn().mockImplementation((cfg: { slotIndex?: number }) => {
    capturedSlotConfigs.push({ slotIndex: cfg.slotIndex });
    return {
      start: vi.fn().mockResolvedValue(undefined),
      wait:  vi.fn().mockResolvedValue(undefined),
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

// Reach into agent private fields for assertions
function freeIndices(agent: WorkerAgent): number[] {
  return (agent as unknown as { freeSlotIndices: number[] }).freeSlotIndices;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkerAgent — slot index pool', () => {
  beforeEach(() => {
    capturedSlotConfigs.length = 0;
    vi.clearAllMocks();
  });

  it('initialises freeSlotIndices with 0..maxSlots-1', () => {
    const agent = makeAgent(4);
    expect(new Set(freeIndices(agent))).toEqual(new Set([0, 1, 2, 3]));
  });

  it('passes a unique slotIndex to each concurrent Slot', async () => {
    const agent = makeAgent(3);
    // Reach into runJob directly (it's private — cast for test)
    const runJob = (agent as unknown as { runJob(j: ReturnType<typeof makeJob>): Promise<void> }).runJob.bind(agent);

    // Stub reportStatus so it doesn't try to POST anywhere
    vi.spyOn(agent as never, 'reportStatus').mockResolvedValue(undefined);

    await Promise.all([runJob(makeJob('j1')), runJob(makeJob('j2')), runJob(makeJob('j3'))]);

    const indices = capturedSlotConfigs.map(c => c.slotIndex);
    expect(new Set(indices)).toEqual(new Set([0, 1, 2]));
  });

  it('returns a slot index to the pool after the job completes', async () => {
    const agent = makeAgent(2);
    const runJob = (agent as unknown as { runJob(j: ReturnType<typeof makeJob>): Promise<void> }).runJob.bind(agent);
    vi.spyOn(agent as never, 'reportStatus').mockResolvedValue(undefined);

    await runJob(makeJob('j1'));
    expect(freeIndices(agent)).toHaveLength(2);
  });

  it('returns the slot index even when the job fails', async () => {
    vi.mocked(
      (await import('../slot.js')).Slot
    ).mockImplementationOnce(() => ({
      start: vi.fn().mockRejectedValue(new Error('runner exited 1')),
      wait:  vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    }));

    const agent = makeAgent(2);
    const runJob = (agent as unknown as { runJob(j: ReturnType<typeof makeJob>): Promise<void> }).runJob.bind(agent);
    vi.spyOn(agent as never, 'reportStatus').mockResolvedValue(undefined);

    await runJob(makeJob('j-fail')).catch(() => {});
    expect(freeIndices(agent)).toHaveLength(2);
  });

  it('two sequential jobs can reuse the same slot index', async () => {
    const agent = makeAgent(1);
    const runJob = (agent as unknown as { runJob(j: ReturnType<typeof makeJob>): Promise<void> }).runJob.bind(agent);
    vi.spyOn(agent as never, 'reportStatus').mockResolvedValue(undefined);

    await runJob(makeJob('j1'));
    await runJob(makeJob('j2'));

    expect(capturedSlotConfigs[0]?.slotIndex).toBe(capturedSlotConfigs[1]?.slotIndex);
  });
});
