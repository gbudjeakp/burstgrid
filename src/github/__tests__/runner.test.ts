import { describe, it, expect, vi, afterEach } from 'vitest';
import { AppClient, AppClientRegistry, RateLimitError } from '../runner.js';

vi.mock('../../telemetry/index.js', () => ({
  logEvent: vi.fn(),
  recordGithubRateLimit: vi.fn(),
  recordGithubRateLimitExceeded: vi.fn(),
}));

function mockClient(label = 'default'): AppClient {
  return { createRunnerToken: vi.fn().mockResolvedValue(`token-${label}`) } as unknown as AppClient;
}

function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('AppClientRegistry', () => {
  describe('fromDefault', () => {
    it('returns the default client for any owner', () => {
      const def = mockClient('default');
      const registry = AppClientRegistry.fromDefault(def);
      expect(registry.clientFor('acme')).toBe(def);
      expect(registry.clientFor('other-org')).toBe(def);
    });
  });

  describe('register + clientFor', () => {
    it('routes to the registered client for that org', () => {
      const def = mockClient('default');
      const acmeClient = mockClient('acme');
      const registry = AppClientRegistry.fromDefault(def);
      registry.register('acme', acmeClient);
      expect(registry.clientFor('acme')).toBe(acmeClient);
    });

    it('falls back to default for unregistered orgs', () => {
      const def = mockClient('default');
      const registry = AppClientRegistry.fromDefault(def);
      registry.register('acme', mockClient('acme'));
      expect(registry.clientFor('unknown-org')).toBe(def);
    });

    it('matches case-insensitively', () => {
      const def = mockClient('default');
      const acmeClient = mockClient('acme');
      const registry = AppClientRegistry.fromDefault(def);
      registry.register('Acme', acmeClient);
      expect(registry.clientFor('ACME')).toBe(acmeClient);
      expect(registry.clientFor('acme')).toBe(acmeClient);
      expect(registry.clientFor('Acme')).toBe(acmeClient);
    });

    it('supports multiple independent orgs', () => {
      const def = mockClient('default');
      const clientA = mockClient('a');
      const clientB = mockClient('b');
      const registry = AppClientRegistry.fromDefault(def);
      registry.register('org-a', clientA);
      registry.register('org-b', clientB);
      expect(registry.clientFor('org-a')).toBe(clientA);
      expect(registry.clientFor('org-b')).toBe(clientB);
      expect(registry.clientFor('org-c')).toBe(def);
    });

    it('overwrites a previously registered org', () => {
      const def = mockClient('default');
      const first = mockClient('first');
      const second = mockClient('second');
      const registry = AppClientRegistry.fromDefault(def);
      registry.register('acme', first);
      registry.register('acme', second);
      expect(registry.clientFor('acme')).toBe(second);
    });
  });
});

describe('AppClient rate limit handling (PAT mode)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports remaining/limit from response headers on a successful call', async () => {
    const { recordGithubRateLimit } = await import('../../telemetry/index.js');
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(201, { token: 'tok-123' }, { 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = AppClient.fromToken('pat-abc');
    const token = await client.createRunnerToken('acme', 'repo');

    expect(token).toBe('tok-123');
    expect(recordGithubRateLimit).toHaveBeenCalledWith('acme', 4999, 5000);
  });

  it('throws a primary RateLimitError and does not retry once quota is exhausted', async () => {
    const { recordGithubRateLimitExceeded } = await import('../../telemetry/index.js');
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(403, { message: 'rate limit exceeded' }, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '1700000000',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = AppClient.fromToken('pat-abc');
    const err: unknown = await client.createRunnerToken('acme', 'repo').catch(e => e);

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).kind).toBe('primary');
    expect((err as RateLimitError).resetAt).toBe(1_700_000_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // RateLimitError skips the retry loop — no point burning more quota
    expect(recordGithubRateLimitExceeded).toHaveBeenCalledWith('acme', 'primary');
  });

  it('throws a secondary RateLimitError when retry-after is present without remaining=0', async () => {
    const { recordGithubRateLimitExceeded } = await import('../../telemetry/index.js');
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(403, { message: 'secondary rate limit' }, {
        'x-ratelimit-remaining': '100',
        'x-ratelimit-limit': '5000',
        'retry-after': '30',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = AppClient.fromToken('pat-abc');
    const err: unknown = await client.createRunnerToken('acme', 'repo').catch(e => e);

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).kind).toBe('secondary');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordGithubRateLimitExceeded).toHaveBeenCalledWith('acme', 'secondary');
  });

  it('retries a plain 500 up to the normal attempt count', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(500, { message: 'boom' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = AppClient.fromToken('pat-abc');
    await expect(client.createRunnerToken('acme', 'repo')).rejects.toThrow('GitHub API 500');
    expect(fetchMock).toHaveBeenCalledTimes(3); // unrelated failures still get the normal retry budget
  });
});
