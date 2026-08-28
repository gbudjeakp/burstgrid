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

  if (!fs.existsSync(filePath)) return {};

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

  return result.data as BurstGridConfig;
}
