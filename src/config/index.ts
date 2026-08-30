import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { TierFleet } from '../fleet/autoscaler.js';
import type { GpuAmiProfile, RootfsImage } from '../types/index.js';

// ─── Zod schema (mirrors BurstGridConfig — validates YAML at startup) ─────────

const RootfsImageSchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string().optional(),
  os: z.string().optional(),
  tools: z.array(z.string()).optional(),
  dockerVersion: z.string().optional(),
}).strict();

const TierFleetSchema = z.object({
  name: z.string(),
  sizeTag: z.string(),
  launchTemplateId: z.string(),
  subnetIds: z.array(z.string()),
  maxWorkers: z.number().int().positive(),
  slotsPerWorker: z.number().int().positive(),
  scaleUpThreshold: z.number().int().nonnegative(),
  scaleDownAfterIdleSec: z.number().int().positive().optional(),
  instanceVcpus: z.number().int().positive().optional(),
  gpuAmiId: z.string().optional(),
  instanceType: z.string().optional(),
  capacityType: z.enum(['spot', 'on-demand']).optional(),
}).strict();

const OrgAppSchema = z.object({
  appId: z.number().int().positive(),
  privateKeyPath: z.string().optional(),
  privateKeyEnv: z.string().optional(),
}).strict();

const ConfigSchema = z.object({
  scheduler: z.object({
    maxQueueDepth: z.number().int().positive().optional(),
    rateLimitMax: z.number().int().positive().optional(),
    rateLimitWindow: z.string().optional(),
    drainTimeoutMs: z.number().int().positive().optional(),
  }).strict().optional(),
  worker: z.object({
    registryMirror: z.string().optional(),
    images: z.array(RootfsImageSchema).optional(),
    dispatchTimeoutMs: z.number().int().positive().optional(),
    jobTimeoutMs: z.number().int().positive().optional(),
    s3Cache: z.object({
      bucketName: z.string(),
      region: z.string().optional(),
      keyPrefix: z.string().optional(),
    }).strict().optional(),
    snapshotPool: z.object({
      size: z.number().int().positive().optional(),
      snapshotDir: z.string().optional(),
    }).strict().optional(),
  }).strict().optional(),
  autoscaler: z.object({
    enabled: z.boolean().optional(),
    evaluationIntervalSec: z.number().positive().optional(),
    fleets: z.array(TierFleetSchema).optional(),
  }).strict().optional(),
  gpuAmis: z.array(z.object({ name: z.string(), amiId: z.string(), region: z.string() }).passthrough()).optional(),
  orgs: z.record(z.string(), OrgAppSchema).optional(),
  // nullable() handles the common YAML case of an all-commented-out section parsing as null
  backends: z.object({
    redis: z.object({ url: z.string() }).strict().optional(),
    sqs: z.object({ queueUrl: z.string(), region: z.string().optional() }).strict().optional(),
    dynamodb: z.object({ tableName: z.string(), region: z.string().optional() }).strict().optional(),
  }).strict().nullable().optional(),
}).strict();

export interface BurstGridConfig {
  scheduler?: {
    maxQueueDepth?: number;
    rateLimitMax?: number;
    rateLimitWindow?: string;
    /** Max ms to wait for in-flight jobs to finish during graceful shutdown. Default: 300_000 (5 min). */
    drainTimeoutMs?: number;
  };
  worker?: {
    registryMirror?: string;
    images?: RootfsImage[];
    /** Ms after dispatch before a job that never reports running is marked failed. Default: 60_000. */
    dispatchTimeoutMs?: number;
    /** Ms after running before a job that never completes is marked failed. Default: 3_600_000 (1h). */
    jobTimeoutMs?: number;
    /** S3-backed GitHub Actions cache — exposes ACTIONS_CACHE_URL to VMs. */
    s3Cache?: { bucketName: string; region?: string; keyPrefix?: string };
    /** Pre-warmed Firecracker snapshot pool for ~5ms VM restore instead of ~150ms cold boot. */
    snapshotPool?: { size?: number; snapshotDir?: string };
  };
  autoscaler?: {
    enabled?: boolean;
    evaluationIntervalSec?: number;
    fleets?: TierFleet[];
  };
  gpuAmis?: GpuAmiProfile[];
  orgs?: {
    [org: string]: {
      appId: number;
      /** Path to PEM file on disk. */
      privateKeyPath?: string;
      /** Name of env var containing the PEM value. */
      privateKeyEnv?: string;
    };
  };
  backends?: {
    redis?: { url?: string };
    sqs?: { queueUrl?: string; region?: string };
    dynamodb?: { tableName?: string; region?: string };
  };
}

export function loadConfig(configPath?: string): BurstGridConfig {
  const filePath = configPath
    ?? process.env.BURSTGRID_CONFIG
    ?? process.env.BURSTGRID_CONFIG_PATH   // alias accepted for compatibility
    ?? path.join(process.cwd(), 'burstgrid.config.yaml');

  if (!fs.existsSync(filePath)) return mergeEnvOverrides({});

  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(filePath, 'utf-8')) ?? {};
  } catch (err) {
    console.error(`[config] failed to parse ${filePath}:`, err);
    process.exit(1);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    console.error(`[config] ${filePath} has invalid fields:\n${result.error.errors.map(e => `  ${e.path.join('.')}: ${e.message}`).join('\n')}`);
    process.exit(1);
  }

  return mergeEnvOverrides(result.data as BurstGridConfig);
}

/**
 * Apply env-var overrides on top of a parsed config (or an empty config when no YAML exists).
 * This lets operators configure BurstGrid entirely through environment variables.
 *
 * Supported vars:
 *   BURSTGRID_REDIS_URL          → backends.redis.url
 *   BURSTGRID_SQS_QUEUE_URL      → backends.sqs.queueUrl
 *   BURSTGRID_SQS_REGION         → backends.sqs.region
 *   BURSTGRID_DYNAMODB_TABLE     → backends.dynamodb.tableName
 *   BURSTGRID_DYNAMODB_REGION    → backends.dynamodb.region
 *   BURSTGRID_AUTOSCALER         → autoscaler.enabled  (true|false|1|0)
 *   BURSTGRID_REGISTRY_MIRROR    → worker.registryMirror
 *   BURSTGRID_S3_CACHE_BUCKET    → worker.s3Cache.bucketName
 *   BURSTGRID_S3_CACHE_REGION    → worker.s3Cache.region
 *   BURSTGRID_SNAPSHOT_POOL_SIZE → worker.snapshotPool.size
 */
export function mergeEnvOverrides(cfg: BurstGridConfig): BurstGridConfig {
  const e = process.env;

  if (e.BURSTGRID_REDIS_URL) {
    cfg.backends = { ...cfg.backends, redis: { url: e.BURSTGRID_REDIS_URL } };
  }
  if (e.BURSTGRID_SQS_QUEUE_URL) {
    cfg.backends = { ...cfg.backends, sqs: { queueUrl: e.BURSTGRID_SQS_QUEUE_URL, region: e.BURSTGRID_SQS_REGION } };
  }
  if (e.BURSTGRID_DYNAMODB_TABLE) {
    cfg.backends = { ...cfg.backends, dynamodb: { tableName: e.BURSTGRID_DYNAMODB_TABLE, region: e.BURSTGRID_DYNAMODB_REGION } };
  }
  if (e.BURSTGRID_AUTOSCALER !== undefined) {
    cfg.autoscaler = { ...cfg.autoscaler, enabled: e.BURSTGRID_AUTOSCALER === 'true' || e.BURSTGRID_AUTOSCALER === '1' };
  }
  if (e.BURSTGRID_REGISTRY_MIRROR) {
    cfg.worker = { ...cfg.worker, registryMirror: e.BURSTGRID_REGISTRY_MIRROR };
  }
  if (e.BURSTGRID_S3_CACHE_BUCKET) {
    cfg.worker = {
      ...cfg.worker,
      s3Cache: { bucketName: e.BURSTGRID_S3_CACHE_BUCKET, region: e.BURSTGRID_S3_CACHE_REGION },
    };
  }
  if (e.BURSTGRID_SNAPSHOT_POOL_SIZE) {
    const size = parseInt(e.BURSTGRID_SNAPSHOT_POOL_SIZE, 10);
    if (!isNaN(size) && size > 0) {
      cfg.worker = { ...cfg.worker, snapshotPool: { ...cfg.worker?.snapshotPool, size } };
    }
  }

  return cfg;
}
