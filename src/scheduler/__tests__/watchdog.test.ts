import { describe, it, expect, vi } from 'vitest';
import { JobWatchdog } from '../watchdog.js';
import { JobMetaCache } from '../job-meta-cache.js';
import { ExecutionTier } from '../../types/index.js';

const META = { owner: 'acme', repo: 'api', runId: 1, tier: ExecutionTier.Standard, labels: ['linux'] };

function makeCache(overrides?: Partial<typeof META>) {
  const c = new JobMetaCache();
  c.set('job-1', { ...META, ...overrides });
  return c;
}

describe('JobWatchdog', () => {
  it('fires timeout for a job with no status after dispatchTimeoutMs', () => {
    vi.useFakeTimers();
    const cache = makeCache();
    // Age the dispatch timestamp past the timeout
    const entry = (cache as unknown as { store: Map<string, { cachedAt: number }> }).store.get('job-1')!;
    entry.cachedAt = Date.now() - 61_000;

    const onTimeout = vi.fn();
    const watchdog = new JobWatchdog(cache, onTimeout, { dispatchTimeoutMs: 60_000, checkIntervalMs: 1_000 });
    vi.advanceTimersByTime(1_001);

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout.mock.calls[0][0]).toBe('job-1');
    expect(onTimeout.mock.calls[0][2]).toMatch(/no status within/);
    watchdog.stop();
    cache.destroy();
    vi.useRealTimers();
  });

  it('does not fire for a recently dispatched job', () => {
    vi.useFakeTimers();
    const cache = makeCache();
    const onTimeout = vi.fn();
    const watchdog = new JobWatchdog(cache, onTimeout, { dispatchTimeoutMs: 60_000, checkIntervalMs: 1_000 });
    vi.advanceTimersByTime(1_001);
    expect(onTimeout).not.toHaveBeenCalled();
    watchdog.stop();
    cache.destroy();
    vi.useRealTimers();
  });

  it('fires timeout for a job stuck in running past jobTimeoutMs', () => {
    vi.useFakeTimers();
    const cache = makeCache();
    cache.touchStatus('job-1');
    const entry = (cache as unknown as { store: Map<string, { lastStatusAt?: number }> }).store.get('job-1')!;
    entry.lastStatusAt = Date.now() - (2 * 60 * 60 * 1_000); // 2h ago

    const onTimeout = vi.fn();
    const watchdog = new JobWatchdog(cache, onTimeout, { jobTimeoutMs: 60 * 60 * 1_000, checkIntervalMs: 1_000 });
    vi.advanceTimersByTime(1_001);

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout.mock.calls[0][2]).toMatch(/no completion within/);
    watchdog.stop();
    cache.destroy();
    vi.useRealTimers();
  });

  it('does not fire for a job that completed normally (removed from cache)', () => {
    vi.useFakeTimers();
    const cache = makeCache();
    cache.delete('job-1');

    const onTimeout = vi.fn();
    const watchdog = new JobWatchdog(cache, onTimeout, { dispatchTimeoutMs: 1, checkIntervalMs: 1_000 });
    vi.advanceTimersByTime(1_001);
    expect(onTimeout).not.toHaveBeenCalled();
    watchdog.stop();
    cache.destroy();
    vi.useRealTimers();
  });

  it('stop() prevents further checks', () => {
    vi.useFakeTimers();
    const cache = makeCache();
    const entry = (cache as unknown as { store: Map<string, { cachedAt: number }> }).store.get('job-1')!;
    entry.cachedAt = Date.now() - 61_000;

    const onTimeout = vi.fn();
    const watchdog = new JobWatchdog(cache, onTimeout, { dispatchTimeoutMs: 60_000, checkIntervalMs: 1_000 });
    watchdog.stop();
    vi.advanceTimersByTime(5_000);
    expect(onTimeout).not.toHaveBeenCalled();
    cache.destroy();
    vi.useRealTimers();
  });
});
