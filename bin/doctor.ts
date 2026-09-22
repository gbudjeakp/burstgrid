import { loadConfig } from '../src/config/index.js';

const HELP = `
Usage: burstgrid doctor [--profile test|prod]

Checks the local BurstGrid config and prints concrete hardening + operability
recommendations before a test run.
`.trim();

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

const profileArg = process.argv.find(a => a.startsWith('--profile='));
const profile = profileArg?.split('=', 2)[1] ?? 'test';
const cfg = loadConfig();
const fleets = cfg.autoscaler?.fleets ?? [];
const scheduler = cfg.scheduler ?? {};
const worker = cfg.worker ?? {};

let warnings = 0;
const ok = (message: string) => console.log(`  OK   ${message}`);
const warn = (message: string) => { warnings++; console.log(`  WARN ${message}`); };
const tip = (message: string) => console.log(`  TIP  ${message}`);

console.log(`\nBurstGrid doctor (${profile})\n`);

if ((worker.secretDelivery ?? 'mmds') === 'mmds') ok('VM secrets use MMDS (kept out of /proc/cmdline).');
else warn('worker.secretDelivery=cmdline exposes runner/cache tokens in guest /proc/cmdline. Prefer MMDS.');

if (worker.snapshotPool?.size) ok(`snapshot pool enabled (size=${worker.snapshotPool.size}).`);
else tip('enable worker.snapshotPool.size=1 or 2 after MMDS validation for faster first-job boot.');

if (scheduler.maxActiveJobsPerWorker) ok(`spot blast radius capped at ${scheduler.maxActiveJobsPerWorker} active job(s) per worker.`);
else warn('scheduler.maxActiveJobsPerWorker is unset; a packed spot host can lose every active slot on interruption.');

if (scheduler.maxPackUtilization !== undefined) ok(`pack utilization target set to ${scheduler.maxPackUtilization}.`);
else tip('set scheduler.maxPackUtilization=0.6-0.8 to trade a little cost for lower per-host concentration.');

if (fleets.length === 0) warn('no autoscaler fleets configured; workers must be started manually.');
for (const fleet of fleets) {
  const capacity = fleet.capacityType ?? 'spot';
  const warm = fleet.minIdleWorkers ?? 0;
  const maxJobs = scheduler.maxActiveJobsPerWorker ?? fleet.slotsPerWorker;
  const interruptionRisk = capacity === 'spot' && maxJobs > 8;
  if (interruptionRisk) warn(`fleet ${fleet.name}: spot + up to ${maxJobs} jobs/worker is a large interruption blast radius.`);
  else ok(`fleet ${fleet.name}: capacity=${capacity}, slots=${fleet.slotsPerWorker}, maxJobs/worker=${maxJobs}, minIdle=${warm}.`);
}

console.log('\nRecommended quick config for safer tests:\n');
console.log(`scheduler:
  maxPackUtilization: 0.7
  maxActiveJobsPerWorker: 8
worker:
  secretDelivery: mmds
  snapshotPool:
    size: 1
`);
console.log('Equivalent env overrides:');
console.log('  BURSTGRID_SECRET_DELIVERY=mmds');
console.log('  BURSTGRID_MAX_PACK_UTILIZATION=0.7');
console.log('  BURSTGRID_MAX_JOBS_PER_WORKER=8');
console.log('  BURSTGRID_SNAPSHOT_POOL_SIZE=1');

if (warnings > 0) {
  console.log(`\nDoctor completed with ${warnings} warning(s).`);
  process.exitCode = 1;
} else {
  console.log('\nDoctor completed cleanly.');
}
