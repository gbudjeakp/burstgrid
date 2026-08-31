import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheServer } from '../cache-server.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSend = vi.fn();
const mockGetSignedUrl = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send = mockSend; }
  class GetObjectCommand { constructor(public input: unknown) {} }
  class PutObjectCommand { constructor(public input: unknown) {} }
  class HeadObjectCommand { constructor(public input: unknown) {} }
  return { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeServer(opts: { token?: string } = {}) {
  return new CacheServer({
    bucketName: 'test-bucket',
    workerToken: opts.token ?? 'test-token',
  });
}

async function request(
  port: number,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token !== null
        ? { Authorization: `Bearer ${opts.token ?? 'test-token'}` }
        : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CacheServer', () => {
  let server: CacheServer;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = makeServer();
    await server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/_apis/artifactcache/cache?keys=k&version=v`, {
      headers: {},
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is wrong', async () => {
    const { status } = await request(server.port, 'GET', '/_apis/artifactcache/cache?keys=k&version=v', { token: 'wrong' });
    expect(status).toBe(401);
  });

  it('GET /cache returns 204 when key is not in S3', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
    const { status } = await request(server.port, 'GET', '/_apis/artifactcache/cache?keys=mykey&version=v1');
    expect(status).toBe(204);
  });

  it('GET /cache returns 200 with archiveLocation when key exists in S3', async () => {
    mockSend.mockResolvedValue({}); // HeadObject succeeds → key exists
    mockGetSignedUrl.mockResolvedValue('https://s3.example.com/presigned');

    const { status, body } = await request(server.port, 'GET', '/_apis/artifactcache/cache?keys=mykey&version=v1');
    expect(status).toBe(200);
    expect((body as { archiveLocation: string }).archiveLocation).toBe('https://s3.example.com/presigned');
  });

  it('GET /cache tries multiple keys and returns the first match', async () => {
    // First key misses, second key hits
    mockSend
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({});
    mockGetSignedUrl.mockResolvedValue('https://s3.example.com/second');

    const { status, body } = await request(server.port, 'GET', '/_apis/artifactcache/cache?keys=miss,hit&version=v1');
    expect(status).toBe(200);
    expect((body as { cacheKey: string }).cacheKey).toBe('hit');
  });

  it('upload flow: POST reserve → PATCH chunk → POST finalize writes to S3', async () => {
    mockSend.mockResolvedValue({});

    // Reserve
    const { status: s1, body: b1 } = await request(server.port, 'POST', '/_apis/artifactcache/caches', {
      body: { key: 'mykey', version: 'v1' },
    });
    expect(s1).toBe(201);
    const { cacheId } = b1 as { cacheId: number };
    expect(typeof cacheId).toBe('number');

    // Upload chunk
    const { status: s2 } = await request(server.port, 'PATCH', `/_apis/artifactcache/caches/${cacheId}`, {
      body: 'chunk-data',
    });
    expect(s2).toBe(204);

    // Finalize
    const { status: s3 } = await request(server.port, 'POST', `/_apis/artifactcache/caches/${cacheId}`);
    expect(s3).toBe(200);

    // Verify PutObjectCommand was called with the right bucket
    const putCall = mockSend.mock.calls.find(
      (args) => (args[0] as { constructor: { name: string } }).constructor.name === 'PutObjectCommand',
    );
    expect(putCall).toBeDefined();
    const putInput = (putCall![0] as { input: { Bucket: string } }).input;
    expect(putInput.Bucket).toBe('test-bucket');
  });

  it('PATCH/finalize to unknown cacheId returns 404', async () => {
    const { status } = await request(server.port, 'PATCH', '/_apis/artifactcache/caches/9999', {
      body: 'data',
    });
    expect(status).toBe(404);
  });

  it('unknown routes return 404', async () => {
    const { status } = await request(server.port, 'GET', '/_apis/unknown-endpoint');
    expect(status).toBe(404);
  });
});

describe('CacheServer — env var integration', () => {
  it('loadConfig reads BURSTGRID_S3_CACHE_BUCKET from env', async () => {
    const { loadConfig } = await import('../../config/index.js');
    const original = process.env.BURSTGRID_S3_CACHE_BUCKET;
    process.env.BURSTGRID_S3_CACHE_BUCKET = 'env-bucket';
    try {
      const cfg = loadConfig('/nonexistent-path.yaml');
      expect(cfg.worker?.s3Cache?.bucketName).toBe('env-bucket');
    } finally {
      if (original === undefined) delete process.env.BURSTGRID_S3_CACHE_BUCKET;
      else process.env.BURSTGRID_S3_CACHE_BUCKET = original;
    }
  });
});
