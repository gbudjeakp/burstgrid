import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { TierFleet } from '../fleet/autoscaler.js';

export interface BurstGridConfig {
  scheduler?: {
    maxQueueDepth?: number;
    rateLimitMax?: number;
    rateLimitWindow?: string;
  };
  autoscaler?: {
    enabled?: boolean;
    evaluationIntervalSec?: number;
    fleets?: TierFleet[];
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
