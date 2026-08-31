import type { AppClientRegistry } from '../github/runner.js';
import type { JobQueue } from './queue.js';
import { probeRun } from '../github/probe.js';

/** Repos with no active runs for this long are dropped from the watch set. */
const INACTIVE_PRUNE_MS = 6 * 60 * 60_000; // 6 hours
/** Max simultaneous GitHub API calls during a reconcile cycle. */
const RECONCILE_CONCURRENCY = 5;

export class Reconciler {
  /** Repos seen from webhook events, added to the watch set automatically. */
  private readonly repos = new Set<string>(); // "owner/repo"
  /** Last time each repo had at least one active run (used to prune stale watch entries). */
  private readonly lastActiveAt = new Map<string, number>();
  /** Repos with an in-flight immediate reconcile; prevents duplicate API calls from concurrent webhooks. */
  private readonly pendingImmediate = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly ghClient: AppClientRegistry,
    private readonly queue: JobQueue,
    private readonly isDraining: () => boolean,
    private readonly maxQueueDepth: number,
    watched: string[] = [],
    private readonly intervalMs = 15_000,
  ) {
    for (const r of watched) {
      if (r.includes('/')) {
        this.repos.add(r);
        this.lastActiveAt.set(r, Date.now());
      }
    }
  }

  /** Call from the webhook handler so newly-seen repos are included in future periodic reconciles. */
  trackRepo(owner: string, repo: string): void {
    const key = `${owner}/${repo}`;
    if (!this.repos.has(key)) {
      this.repos.add(key);
      this.lastActiveAt.set(key, Date.now()); // start the inactivity countdown from now
    }
  }

  /**
   * Immediately reconcile a repo when a webhook arrives, debounced per-repo so that a burst of
   * concurrent webhooks collapses into a single API call rather than one per event.
   */
  triggerNow(owner: string, repo: string): void {
    const key = `${owner}/${repo}`;
    this.repos.add(key);
    if (this.isDraining() || this.pendingImmediate.has(key)) return;
    this.pendingImmediate.add(key);
    setTimeout(() => {
      this.pendingImmediate.delete(key);
      void this.reconcileRepo(owner, repo).catch(err =>
        console.error(`[reconciler] immediate ${key}:`, err),
      );
    }, 250);
  }

  /** Reconcile immediately on startup, then on a fixed interval. */
  start(): void {
    void this.reconcileAll();
    this.timer = setInterval(() => void this.reconcileAll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async reconcileAll(): Promise<void> {
    const repos = [...this.repos];
    // Process in parallel batches to avoid sequential API round-trips
    for (let i = 0; i < repos.length; i += RECONCILE_CONCURRENCY) {
      await Promise.all(
        repos.slice(i, i + RECONCILE_CONCURRENCY).map(fullName => {
          const [owner, repo] = fullName.split('/');
          return this.reconcileRepo(owner, repo).catch(err =>
            console.error(`[reconciler] ${fullName}:`, err),
          );
        }),
      );
    }
    this.pruneInactive();
  }

  private pruneInactive(): void {
    const cutoff = Date.now() - INACTIVE_PRUNE_MS;
    for (const fullName of this.repos) {
      if ((this.lastActiveAt.get(fullName) ?? 0) < cutoff) {
        this.repos.delete(fullName);
        this.lastActiveAt.delete(fullName);
        console.info(`[reconciler] pruned inactive repo ${fullName}`);
      }
    }
  }

  private async reconcileRepo(owner: string, repo: string): Promise<void> {
    const client = this.ghClient.clientFor(owner);
    const runs = await client.listActiveRuns(owner, repo);
    if (runs.length > 0) {
      console.info(`[reconciler] ${owner}/${repo}: checking ${runs.length} active run(s)`);
      this.lastActiveAt.set(`${owner}/${repo}`, Date.now());
    }
    for (const run of runs) {
      await probeRun({
        owner, repo, runId: run.id, client,
        queue:         this.queue,
        isDraining:    this.isDraining,
        maxQueueDepth: this.maxQueueDepth,
      });
    }
  }
}
