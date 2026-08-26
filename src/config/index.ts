import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { TierFleet } from '../fleet/autoscaler.js';
import type { GpuAmiProfile, RootfsImage } from '../types/index.js';

export interface BurstGridConfig {
  scheduler?: {
    maxQueueDepth?: number;
    rateLimitMax?: number;
    rateLimitWindow?: string;
  };
  worker?: {
    /** Docker pull-through registry mirror URL. Env: BURSTGRID_REGISTRY_MIRROR */
    registryMirror?: string;
    /**
     * Named rootfs image catalog. Maps burstgrid:image=<name> labels to absolute
     * paths on the worker host. When omitted, the worker resolves images via
     * imageDir/<name>.img convention.
     */
    images?: RootfsImage[];
  };
  autoscaler?: {
    enabled?: boolean;
    evaluationIntervalSec?: number;
    fleets?: TierFleet[];
  };
  /**
   * Pre-baked GPU AMI profiles.  Each profile describes an AMI with CUDA drivers,
   * ML frameworks, and optionally model weights pre-installed for fast job start.
   * Reference a profile by name in a TierFleet via gpuAmiId.
   */
  gpuAmis?: GpuAmiProfile[];
  backends?: {
    redis?: {
      /** Redis connection URL, e.g. redis://your-elasticache:6379. Env: BURSTGRID_REDIS_URL */
      url?: string;
    };
    sqs?: {
      /** SQS queue URL. Env: BURSTGRID_SQS_QUEUE_URL */
      queueUrl?: string;
      /** AWS region for SQS. Env: BURSTGRID_SQS_REGION */
      region?: string;
    };
    dynamodb?: {
      /** DynamoDB table name for job history. Env: BURSTGRID_DYNAMODB_TABLE */
      tableName?: string;
      /** AWS region for DynamoDB. Env: BURSTGRID_DYNAMODB_REGION */
      region?: string;
    };
  };
}

export function loadConfig(configPath?: string): BurstGridConfig {
  const filePath = configPath
    ?? process.env.BURSTGRID_CONFIG
    ?? path.join(process.cwd(), 'burstgrid.config.yaml');

  if (!fs.existsSync(filePath)) return {};
  try {
    return (parse(fs.readFileSync(filePath, 'utf-8')) as BurstGridConfig) ?? {};
  } catch (err) {
    console.warn(`[config] failed to parse ${filePath}:`, err);
    return {};
  }
}
