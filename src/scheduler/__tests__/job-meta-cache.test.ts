import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobMetaCache } from '../job-meta-cache.js';
import { ExecutionTier } from '../../types/index.js';

const META = { owner: 'acme', repo: 'api', runId: 1, tier: ExecutionTier.Standard, labels: ['linux'] };

describe('JobMetaCache', () => {
  it('stores and retrieves a job', () => {
    const cache = new JobMetaCache();
    cache.set('job-1', META);
    expect(cache.get('job-1')).toMatchObject(META);
    cache.destroy();
  });

  it('returns undefined for unknown jobId', () => {
    const cache = new JobMetaCache();
    expect(cache.get('missing')).toBeUndefined();
    cache.destroy();
  });

  it('deletes a job', () => {
    const cache = new JobMetaCache();
    cache.set('job-1', META);
    cache.delete('job-1');
    expect(cache.get('job-1')).toBeUndefined();
    cache.destroy();
  });

  it('tracks size correctly', () => {
    const cache = new JobMetaCache();
    cache.set('a', META);
    cache.set('b', META);
    expect(cache.size).toBe(2);
    cache.delete('a');
    expect(cache.size).toBe(1);
    cache.destroy();
  });

  it('stamps cachedAt on insertion', () => {
    const now = Date.now();
    const cache = new JobMetaCache();
    cache.set('job-1', META);
    const entry = cache.get('job-1')!;
    expect(entry.cachedAt).toBeGreaterThanOrEqual(now);
    cache.destroy();
  });

  it('evicts stale entries when evict runs', () => {
    vi.useFakeTimers();
    const cache = new JobMetaCache();
    cache.set('old', META);
    // Manually age the entry past the 1h TTL
    const entry = (cache as unknown as { store: Map<string, { cachedAt: number }> }).store.get('old')!;
    entry.cachedAt = Date.now() - (61 * 60 * 1_000);
    // Advance time to trigger the 5-min eviction interval
    vi.advanceTimersByTime(5 * 60 * 1_000 + 1);
    expect(cache.get('old')).toBeUndefined();
    cache.destroy();
    vi.useRealTimers();
  });

  it('does not evict recent entries during eviction pass', () => {
    vi.useFakeTimers();
    const cache = new JobMetaCache();
    cache.set('fresh', META);
    vi.advanceTimersByTime(5 * 60 * 1_000 + 1);
    expect(cache.get('fresh')).toBeDefined();
    cache.destroy();
    vi.useRealTimers();
  });

  it('emits drain when the last entry is deleted', () => {
    const cache = new JobMetaCache();
    const spy = vi.fn();
    cache.on('drain', spy);
    cache.set('job-1', META);
    cache.delete('job-1');
    expect(spy).toHaveBeenCalledOnce();
    cache.destroy();
  });

  it('does not emit drain when items remain after delete', () => {
    const cache = new JobMetaCache();
    const spy = vi.fn();
    cache.on('drain', spy);
    cache.set('job-1', META);
    cache.set('job-2', META);
    cache.delete('job-1');
    expect(spy).not.toHaveBeenCalled();
    cache.destroy();
  });

  it('does not emit drain when deleting a key that does not exist', () => {
    const cache = new JobMetaCache();
    const spy = vi.fn();
    cache.on('drain', spy);
    cache.delete('missing');
    expect(spy).not.toHaveBeenCalled();
    cache.destroy();
  });
});
