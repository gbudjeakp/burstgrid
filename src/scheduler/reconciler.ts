import type { AppClientRegistry } from '../github/runner.js';
import type { JobQueue } from './queue.js';
import { probeRun } from '../github/probe.js';

export class Reconciler {
  /** Repos seen from webhook events, added to the watch set automatically. */
  private readonly repos = new Set<string>(); // "owner/repo"
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
      if (r.includes('/')) this.repos.add(r);
    }
  }

  /** Call from the webhook handler so newly-seen repos are included in future periodic reconciles. */
  trackRepo(owner: string, repo: string): void {
    this.repos.add(`${owner}/${repo}`);
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
    for (const fullName of this.repos) {
      const [owner, repo] = fullName.split('/');
      await this.reconcileRepo(owner, repo).catch(err =>
        console.error(`[reconciler] ${fullName}:`, err),
      );
    }
  }

  private async reconcileRepo(owner: string, repo: string): Promise<void> {
    const client = this.ghClient.clientFor(owner);
    const runs = await client.listActiveRuns(owner, repo);
    if (runs.length > 0) {
      console.info(`[reconciler] ${owner}/${repo}: checking ${runs.length} active run(s)`);
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
