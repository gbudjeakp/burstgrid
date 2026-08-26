import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectCapabilities, detectWorkerId, type ExecFn, type FetchFn } from '../detect.js';

// ─── detectCapabilities ───────────────────────────────────────────────────────

describe('detectCapabilities', () => {
  const noExec: ExecFn = () => { throw new Error('not found'); };
  const okExec: ExecFn = () => Buffer.from('ok');

  afterEach(() => vi.restoreAllMocks());

  it('includes linux and x86_64 on non-arm64 hosts', () => {
    const caps = detectCapabilities('x64', noExec);
    expect(caps).toContain('linux');
    expect(caps).toContain('x86_64');
    expect(caps).not.toContain('arm64');
  });

  it('includes arm64 on arm hosts', () => {
    const caps = detectCapabilities('arm64', noExec);
    expect(caps).toContain('arm64');
    expect(caps).not.toContain('x86_64');
  });

  it('adds docker when the first exec call succeeds', () => {
    let call = 0;
    const exec: ExecFn = () => {
      if (call++ === 0) return Buffer.from('abc123'); // docker info
      throw new Error('no nvidia');
    };
    expect(detectCapabilities('x64', exec)).toContain('docker');
  });

  it('adds gpu and cuda when nvidia-smi succeeds', () => {
    let call = 0;
    const exec: ExecFn = () => {
      if (call++ === 0) throw new Error('no docker'); // docker info fails
      return Buffer.from('Tesla T4');              // nvidia-smi succeeds
    };
    const caps = detectCapabilities('x64', exec);
    expect(caps).toContain('gpu');
    expect(caps).toContain('cuda');
  });

  it('adds both docker and gpu when both execs succeed', () => {
    const caps = detectCapabilities('x64', okExec);
    expect(caps).toContain('docker');
    expect(caps).toContain('gpu');
    expect(caps).toContain('cuda');
  });

  it('does not include docker or gpu when both commands fail', () => {
    const caps = detectCapabilities('x64', noExec);
    expect(caps).not.toContain('docker');
    expect(caps).not.toContain('gpu');
    expect(caps).not.toContain('cuda');
  });
});

// ─── detectWorkerId ───────────────────────────────────────────────────────────

describe('detectWorkerId', () => {
  const hostname = () => 'my-host';

  it('returns the EC2 instance-id when IMDS responds', async () => {
    const fetchFn: FetchFn = async () => ({ ok: true, text: async () => 'i-0abc1234def56789' });
    expect(await detectWorkerId(fetchFn, hostname)).toBe('i-0abc1234def56789');
  });

  it('falls back to hostname when IMDS throws', async () => {
    const fetchFn: FetchFn = async () => { throw new Error('ETIMEDOUT'); };
    expect(await detectWorkerId(fetchFn, hostname)).toBe('my-host');
  });

  it('falls back to hostname when IMDS returns a non-ok response', async () => {
    const fetchFn: FetchFn = async () => ({ ok: false, text: async () => '' });
    expect(await detectWorkerId(fetchFn, hostname)).toBe('my-host');
  });
});
