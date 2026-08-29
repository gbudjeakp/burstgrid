import crypto from 'node:crypto';
import { selectTier } from '../scheduler/router.js';
import type { JobQueue } from '../scheduler/queue.js';
import type { AppClient } from './runner.js';
import type { Job } from '../types/index.js';
import { openJobSpan } from '../telemetry/index.js';

// Tracks GitHub job IDs we've already provisioned a runner for. Prevents double-provisioning
// when the same job arrives via both a webhook event and the reconciler.
const provisionedIds = new Map<number, number>(); // githubJobId -> expiresAt ms
const PROVISION_TTL_MS = 30 * 60 * 1000;

// Per-run lock: collapse concurrent probes for the same run into one GitHub API call.
const reconciling = new Set<number>();
// Runs that arrived while a probe was in-flight; one follow-up pass is scheduled after unlock.
const pendingProbe = new Set<number>();

export function markProvisioned(id: number): boolean {
  const now = Date.now();
  for (const [k, exp] of provisionedIds) {
    if (now > exp) provisionedIds.delete(k);
  }
  if (provisionedIds.has(id)) return false;
  provisionedIds.set(id, now + PROVISION_TTL_MS);
  return true;
}

export function unmarkProvisioned(id: number): void {
  provisionedIds.delete(id);
}

export interface ProbeOpts {
  owner: string;
  repo: string;
  runId: number;
  client: AppClient;
  queue: JobQueue;
  isDraining: () => boolean;
  maxQueueDepth: number;
}

export async function probeRun(opts: ProbeOpts): Promise<void> {
  const { owner, repo, runId, client, queue, isDraining, maxQueueDepth } = opts;

  if (reconciling.has(runId)) {
    // Lock held — schedule one follow-up probe so siblings missed during the in-flight call
    // are still provisioned once the current probe finishes.
    pendingProbe.add(runId);
    return;
  }
  reconciling.add(runId);

  try {
    let jobs: Array<{ id: number; status: string; labels: string[] }>;
    try {
      jobs = await client.listJobsForRun(owner, repo, runId);
    } catch {
      return;
    }

    const queued = jobs.filter(j => j.status === 'queued');
    let provisioned = 0;

    for (const sibling of queued) {
      if (!markProvisioned(sibling.id)) continue;
      if (isDraining() || queue.depth >= maxQueueDepth) break;

      let runnerToken: string;
      try {
        runnerToken = await client.createRunnerToken(owner, repo);
      } catch {
        provisionedIds.delete(sibling.id);
        continue;
      }

      const job: Job = {
        id: crypto.randomUUID(),
        owner,
        repo,
        runId,
        labels: sibling.labels,
        tier: selectTier(sibling.labels),
        queuedAt: new Date(),
        runnerToken,
        githubJobId: sibling.id,
      };
      queue.enqueue(job);
      openJobSpan(job.id, job.owner, job.repo, job.tier);
      provisioned++;
    }

    if (provisioned > 0) {
      console.info(`[probe] run=${runId} ${owner}/${repo}: provisioned ${provisioned} runner(s) for missed queued jobs`);
    }
  } finally {
    reconciling.delete(runId);
    // If sibling webhook events arrived while we held the lock, run one more pass.
    if (pendingProbe.delete(runId)) void probeRun(opts);
  }
}
