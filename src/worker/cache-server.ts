/**
 * Lightweight GitHub Actions artifact-cache protocol server backed by S3.
 * Inject ACTIONS_CACHE_URL=http://localhost:<port>/ into VMs to activate actions/cache.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface CacheServerConfig {
  bucketName: string;
  region?: string;
  keyPrefix?: string;
  /** Token VMs must present as the Bearer in Authorization / X-TFS-FedAuthToken. */
  workerToken: string;
}

interface PendingUpload {
  key: string;
  chunks: Buffer[];
}

export class CacheServer {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly token: string;
  private readonly pending = new Map<number, PendingUpload>();
  private nextCacheId = 1;
  private server: http.Server | null = null;
  public port = 0;

  constructor(private readonly cfg: CacheServerConfig) {
    this.s3 = new S3Client({ region: cfg.region });
    this.bucket = cfg.bucketName;
    this.prefix = cfg.keyPrefix?.replace(/\/$/, '') ?? 'actions-cache';
    this.token = cfg.workerToken;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch(err => {
        console.error('[cache-server] unhandled error:', err);
        if (!res.writableEnded) res.writeHead(500).end(JSON.stringify({ message: String(err) }));
      });
    });
    await new Promise<void>(resolve => {
      this.server!.listen(0, '127.0.0.1', () => {
        this.port = (this.server!.address() as { port: number }).port;
        resolve();
      });
    });
    console.info(`[cache-server] listening on port ${this.port} (bucket: ${this.bucket})`);
  }

  stop(): void {
    this.server?.close();
  }

  private auth(req: http.IncomingMessage): boolean {
    const header = req.headers['authorization'] ?? req.headers['x-tfs-fedauthtoken'] ?? '';
    return String(header).replace(/^Bearer\s+/i, '') === this.token;
  }

  private s3Key(cacheKey: string, version: string): string {
    const hash = crypto.createHash('sha256').update(`${cacheKey}:${version}`).digest('hex');
    return `${this.prefix}/${hash}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json');

    if (!this.auth(req)) {
      res.writeHead(401).end(JSON.stringify({ message: 'Unauthorized' }));
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost`);
    const path = url.pathname;

    // GET /_apis/artifactcache/cache?keys=key1,key2&version=<ver>
    if (req.method === 'GET' && path.startsWith('/_apis/artifactcache/cache')) {
      const keys = (url.searchParams.get('keys') ?? '').split(',').map(k => k.trim()).filter(Boolean);
      const version = url.searchParams.get('version') ?? '';

      for (const key of keys) {
        const s3key = this.s3Key(key, version);
        try {
          await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: s3key }));
          const downloadUrl = await getSignedUrl(
            this.s3,
            new GetObjectCommand({ Bucket: this.bucket, Key: s3key }),
            { expiresIn: 3600 },
          );
          res.writeHead(200).end(JSON.stringify({
            cacheKey: key, scope: 'refs/heads/main', archiveLocation: downloadUrl,
          }));
          return;
        } catch {
          // key not found — try next
        }
      }
      res.writeHead(204).end();
      return;
    }

    // POST /_apis/artifactcache/caches  — reserve a cache entry
    if (req.method === 'POST' && path === '/_apis/artifactcache/caches') {
      const body = await readBody(req);
      const { key, version } = JSON.parse(body) as { key: string; version: string };
      const cacheId = this.nextCacheId++;
      this.pending.set(cacheId, { key: this.s3Key(key, version), chunks: [] });
      res.writeHead(201).end(JSON.stringify({ cacheId }));
      return;
    }

    // PATCH /_apis/artifactcache/caches/:id  — upload chunk
    if (req.method === 'PATCH' && path.startsWith('/_apis/artifactcache/caches/')) {
      const id = parseInt(path.split('/').at(-1) ?? '', 10);
      const entry = this.pending.get(id);
      if (!entry) { res.writeHead(404).end(); return; }
      const chunk = await readBodyRaw(req);
      entry.chunks.push(chunk);
      res.writeHead(204).end();
      return;
    }

    // POST /_apis/artifactcache/caches/:id  — finalize upload
    if (req.method === 'POST' && /\/_apis\/artifactcache\/caches\/\d+$/.test(path)) {
      const id = parseInt(path.split('/').at(-1) ?? '', 10);
      const entry = this.pending.get(id);
      if (!entry) { res.writeHead(404).end(); return; }
      const body = Buffer.concat(entry.chunks);
      this.pending.delete(id);
      await this.s3.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: entry.key,
        Body: body,
        ContentLength: body.length,
      }));
      res.writeHead(200).end();
      return;
    }

    res.writeHead(404).end(JSON.stringify({ message: 'Not found' }));
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function readBodyRaw(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
