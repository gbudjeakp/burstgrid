import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FlociContainer, type StartedFlociContainer } from '@floci/testcontainers';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { CacheServer } from '../cache-server.js';

// Runs the actions/cache v1 protocol (reserve/upload/commit/get, including the presigned
// download URL it hands back) against real Floci-emulated S3, instead of the hand-mocked
// S3Client used elsewhere — presigned URLs are exactly the kind of thing that looks right
// in a mock and breaks against a real endpoint (signature, host, path-style mismatches).
describe('CacheServer (Floci integration)', () => {
  let floci: StartedFlociContainer;
  let originalEnv: Record<string, string | undefined>;
  let server: CacheServer;
  const bucket = 'burstgrid-cache-test';
  const token = 'test-worker-token';

  beforeAll(async () => {
    floci = await new FlociContainer().start();

    originalEnv = {
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    };
    // CacheServer builds its own S3 client with no endpoint override — same env-var contract
    // it would use against real AWS, including for the presigned URLs it generates.
    process.env.AWS_ENDPOINT_URL = floci.getEndpoint();
    process.env.AWS_ACCESS_KEY_ID = floci.getAccessKey();
    process.env.AWS_SECRET_ACCESS_KEY = floci.getSecretKey();

    const setup = new S3Client({ region: floci.getRegion(), forcePathStyle: true });
    await setup.send(new CreateBucketCommand({ Bucket: bucket }));
    setup.destroy();

    server = new CacheServer({ bucketName: bucket, region: floci.getRegion(), workerToken: token });
    await server.start();
  }, 90_000);

  afterAll(async () => {
    server.stop();
    process.env.AWS_ENDPOINT_URL = originalEnv.AWS_ENDPOINT_URL;
    process.env.AWS_ACCESS_KEY_ID = originalEnv.AWS_ACCESS_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = originalEnv.AWS_SECRET_ACCESS_KEY;
    await floci.stop();
  });

  it('reserves, uploads, commits, and retrieves a cache entry via the real protocol', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { Authorization: `Bearer ${token}` };
    const payload = Buffer.from('hello from the cache');

    const reserveRes = await fetch(`${base}/_apis/artifactcache/caches`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'node-modules', version: 'v1' }),
    });
    expect(reserveRes.status).toBe(201);
    const { cacheId } = await reserveRes.json() as { cacheId: number };

    const uploadRes = await fetch(`${base}/_apis/artifactcache/caches/${cacheId}`, {
      method: 'PATCH',
      headers,
      body: payload,
    });
    expect(uploadRes.status).toBe(204);

    const commitRes = await fetch(`${base}/_apis/artifactcache/caches/${cacheId}`, {
      method: 'POST',
      headers,
    });
    expect(commitRes.status).toBe(200);

    const getRes = await fetch(`${base}/_apis/artifactcache/cache?keys=node-modules&version=v1`, { headers });
    expect(getRes.status).toBe(200);
    const { archiveLocation } = await getRes.json() as { archiveLocation: string };

    // Follow the presigned URL ourselves, the same way the real actions/cache client would.
    const download = await fetch(archiveLocation);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(payload);
  }, 30_000);
});
