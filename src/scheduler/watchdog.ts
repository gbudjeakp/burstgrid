import type { JobMetaCache, CachedJobMeta } from './job-meta-cache.js';

export interface WatchdogOptions {
  /** Ms after dispatch with no status before the job is declared stuck. Default: 60_000. */
  dispatchTimeoutMs?: number;
  /** Ms after first status with no completion before the job is declared stuck. Default: 3_600_000. */
  jobTimeoutMs?: number;
  checkIntervalMs?: number;
}

export type TimeoutCallback = (jobId: string, meta: CachedJobMeta, reason: string) => void;

const DEFAULTS = {
  dispatchTimeoutMs: 60_000,
  jobTimeoutMs: 60 * 60 * 1_000,
  checkIntervalMs: 30_000,
};

export class JobWatchdog {
  private readonly timer: NodeJS.Timeout;
  private readonly dispatchTimeoutMs: number;
  private readonly jobTimeoutMs: number;

  constructor(
    private readonly cache: JobMetaCache,
    private readonly onTimeout: TimeoutCallback,
    opts: WatchdogOptions = {},
  ) {
    this.dispatchTimeoutMs = opts.dispatchTimeoutMs ?? DEFAULTS.dispatchTimeoutMs;
    this.jobTimeoutMs      = opts.jobTimeoutMs      ?? DEFAULTS.jobTimeoutMs;
    this.timer = setInterval(() => this.check(), opts.checkIntervalMs ?? DEFAULTS.checkIntervalMs);
    this.timer.unref();
  }

  private check(): void {
    const now = Date.now();
    for (const [jobId, meta] of (this.cache as unknown as { store: Map<string, CachedJobMeta> }).store) {
      if (meta.lastStatusAt === undefined) {
        // Never reported any status — check against dispatch timeout
        if (now - meta.cachedAt > this.dispatchTimeoutMs) {
          this.onTimeout(jobId, meta, `no status within ${this.dispatchTimeoutMs}ms of dispatch`);
        }
      } else {
        // Reported at least one status — check against job timeout
        if (now - meta.lastStatusAt > this.jobTimeoutMs) {
          this.onTimeout(jobId, meta, `no completion within ${this.jobTimeoutMs}ms of last status`);
        }
      }
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
