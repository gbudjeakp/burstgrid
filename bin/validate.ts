#!/usr/bin/env node
/**
 * burstgrid validate — parse and validate burstgrid.config.yaml without starting the server.
 * Exit 0 on success, 1 on error (Zod errors printed by loadConfig).
 */
import { loadConfig } from '../src/config/index.js';

const cfg = loadConfig(process.argv[2]);

const sections = [
  cfg.scheduler    && 'scheduler',
  cfg.worker       && 'worker',
  cfg.autoscaler   && `autoscaler (${cfg.autoscaler.fleets?.length ?? 0} fleet(s))`,
  cfg.backends     && `backends (${Object.keys(cfg.backends).join(', ')})`,
  cfg.gpuAmis      && `gpuAmis (${cfg.gpuAmis.length})`,
].filter(Boolean);

console.log(`config OK${sections.length ? ' — ' + sections.join(', ') : ' (empty)'}`);
