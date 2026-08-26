#!/usr/bin/env node
/**
 * Inject a test job into a running BurstGrid scheduler.
 * Only works when NODE_ENV !== 'production' (scheduler must expose /v1/jobs/inject).
 *
 * Usage:
 *   node --import tsx/esm scripts/inject-job.ts [options]
 *
 * Options:
 *   --url        Scheduler base URL  (default: http://localhost:8080)
 *   --owner      GitHub org/user     (default: acme)
 *   --repo       Repository name     (default: my-repo)
 *   --labels     Comma-separated labels (default: linux,x86_64,docker)
 *   --count      Number of jobs to inject (default: 1)
 *   --size       VM size label shorthand: small|medium|large|xlarge|2xlarge|4xlarge|8xlarge
 *   --gpu        Append 'gpu' to labels
 *   --image      Append 'burstgrid:image=<name>' to labels
 */

const args = parseArgs(process.argv.slice(2));

const url     = args['url']    ?? 'http://localhost:8080';
const owner   = args['owner']  ?? 'acme';
const repo    = args['repo']   ?? 'my-repo';
const count   = Number(args['count'] ?? 1);
const labels  = (args['labels'] ?? 'linux,x86_64,docker').split(',').map((s: string) => s.trim());

if (args['size'])  labels.push(`burstgrid:size=${args['size']}`);
if (args['image']) labels.push(`burstgrid:image=${args['image']}`);
if ('gpu' in args) labels.push('gpu');

console.log(`Injecting ${count} job(s) → ${url}`);
console.log(`  owner=${owner}  repo=${repo}  labels=[${labels.join(', ')}]\n`);

for (let i = 0; i < count; i++) {
  const body = { owner, repo, runId: Date.now() + i, labels };
  const res  = await fetch(`${url}/v1/jobs/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[${i + 1}/${count}] FAIL ${res.status}: ${text}`);
    process.exit(1);
  }

  const { jobId } = await res.json() as { jobId: string };
  console.log(`[${i + 1}/${count}] queued ${jobId}`);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      out[key] = argv[i + 1]?.startsWith('--') ? 'true' : (argv[++i] ?? 'true');
    }
  }
  return out;
}
