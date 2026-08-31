#!/usr/bin/env node
/**
 * burstgrid deploy — build, upload to S3, optionally apply Terraform.
 *
 * Usage:
 *   burstgrid deploy [options]
 *
 * Options:
 *   --bucket   <name>   S3 bucket to upload scheduler.mjs + worker-agent.mjs into.
 *                       Falls back to BURSTGRID_S3_BUCKET env var or auto-detected from
 *                       deploy/terraform/terraform.tfvars.
 *   --region   <name>   AWS region (default: us-east-1 or AWS_REGION env var).
 *   --prefix   <key>    S3 key prefix (default: empty).
 *   --terraform <dir>   Run `terraform apply -auto-approve` in this directory after upload.
 *                       Defaults to deploy/terraform if it exists and --no-terraform is not set.
 *   --no-terraform      Skip Terraform step.
 *   --skip-build        Skip build; fail if dist/ artefacts are missing.
 *   --dry-run           Print what would happen without doing it.
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
function flag(name: string): boolean { return args.includes(`--${name}`); }
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

const dryRun    = flag('dry-run');
const skipBuild = flag('skip-build');
const noTf      = flag('no-terraform');

// ── Resolve S3 bucket ─────────────────────────────────────────────────────────

function bucketFromTfvars(dir: string): string | undefined {
  const tfvars = path.join(dir, 'terraform.tfvars');
  if (!fs.existsSync(tfvars)) return undefined;
  const match = fs.readFileSync(tfvars, 'utf-8').match(/s3_artifacts_bucket\s*=\s*"([^"]+)"/);
  return match?.[1];
}

const bucket = opt('bucket')
  ?? process.env.BURSTGRID_S3_BUCKET
  ?? bucketFromTfvars(path.join(root, 'deploy', 'terraform'));

if (!bucket) {
  console.error(
    '[deploy] No S3 bucket specified.\n' +
    '  Use --bucket <name>, set BURSTGRID_S3_BUCKET, or add s3_artifacts_bucket to deploy/terraform/terraform.tfvars',
  );
  process.exit(1);
}

const region  = opt('region') ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const prefix  = opt('prefix') ? opt('prefix')!.replace(/\/$/, '') + '/' : '';
const tfDir   = opt('terraform') ?? path.join(root, 'deploy', 'terraform');
const runTf   = !noTf && fs.existsSync(tfDir);

console.log(`[deploy] bucket=${bucket} region=${region}${prefix ? ` prefix=${prefix}` : ''}${runTf ? ` terraform=${tfDir}` : ''}`);
if (dryRun) console.log('[deploy] dry-run — no changes will be made');

// ── Build ─────────────────────────────────────────────────────────────────────

const artifacts = [
  path.join(root, 'dist', 'scheduler.mjs'),
  path.join(root, 'dist', 'worker-agent.mjs'),
];

const needsBuild = artifacts.some(f => !fs.existsSync(f));
if (needsBuild && skipBuild) {
  console.error(`[deploy] dist/ artefacts missing and --skip-build was set. Run \`pnpm build\` first.`);
  process.exit(1);
}

if (needsBuild) {
  console.log('[deploy] Building…');
  if (!dryRun) {
    const result = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit', shell: true });
    if (result.status !== 0) { console.error('[deploy] Build failed'); process.exit(1); }
  }
}

// ── Preflight: check required tools are available ───────────────────────────

function toolAvailable(name: string): boolean {
  const r = spawnSync(name, ['--version'], { encoding: 'utf-8' });
  return !r.error;
}

if (!toolAvailable('aws')) {
  console.error('[deploy] AWS CLI not found.\n  Install it: https://aws.amazon.com/cli/');
  process.exit(1);
}

if (runTf && !toolAvailable('terraform')) {
  console.error('[deploy] terraform not found.\n  Install it: https://developer.hashicorp.com/terraform/install\n  Or pass --no-terraform to skip the Terraform step.');
  process.exit(1);
}

// ── Upload to S3 ──────────────────────────────────────────────────────────────

for (const file of artifacts) {
  const key = `${prefix}${path.basename(file)}`;
  const s3Uri = `s3://${bucket}/${key}`;
  console.log(`[deploy] upload ${path.relative(root, file)} → ${s3Uri}`);
  if (!dryRun) {
    const result = spawnSync(
      'aws', ['s3', 'cp', file, s3Uri, '--region', region],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      const hint = result.stderr?.toString().trim();
      console.error(`[deploy] Upload failed: ${file}`);
      if (hint) console.error(`  ${hint.split('\n')[0]}`);
      console.error('  Check that the bucket exists and your IAM role has s3:PutObject permission.');
      process.exit(1);
    }
  }
}

// ── Upload Firecracker binaries ───────────────────────────────────────────────
// Workers prefer s3://bucket/bin/firecracker-<arch> over a GitHub download.
// Run `burstgrid deploy --firecracker-version v1.16.1` to refresh.

const fcVersion = opt('firecracker-version') ?? 'v1.16.1';
const fcArches = ['aarch64', 'x86_64'] as const;

for (const fcArch of fcArches) {
  const tgzName = `firecracker-${fcVersion}-${fcArch}.tgz`;
  const tmpTgz  = path.join(os.tmpdir(), tgzName);
  const s3Key   = `${prefix}bin/firecracker-${fcArch}`;
  const s3Uri   = `s3://${bucket}/${s3Key}`;

  const existing = spawnSync('aws', ['s3', 'ls', s3Uri, '--region', region], { encoding: 'utf-8' });
  if (existing.status === 0) {
    console.log(`[deploy] firecracker-${fcArch} already in S3, skipping (use --force-firecracker to re-upload)`);
    continue;
  }

  console.log(`[deploy] downloading firecracker ${fcVersion} ${fcArch} from GitHub...`);
  if (!dryRun) {
    execSync(
      `curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/${fcVersion}/${tgzName}" -o "${tmpTgz}"`,
      { stdio: 'inherit' },
    );
    execSync(`tar -xz -C "${path.dirname(tmpTgz)}" -f "${tmpTgz}"`, { stdio: 'inherit' });
    const extracted = path.join(path.dirname(tmpTgz), `release-${fcVersion}-${fcArch}`, `firecracker-${fcVersion}-${fcArch}`);
    spawnSync('aws', ['s3', 'cp', extracted, s3Uri, '--region', region], { stdio: 'inherit' });
    fs.rmSync(path.join(path.dirname(tmpTgz), `release-${fcVersion}-${fcArch}`), { recursive: true, force: true });
    fs.rmSync(tmpTgz, { force: true });
    console.log(`[deploy] uploaded firecracker-${fcArch} → ${s3Uri}`);
  }
}

// ── Terraform ─────────────────────────────────────────────────────────────────

if (runTf) {
  console.log(`[deploy] Running terraform apply in ${tfDir}…`);
  if (!dryRun) {
    const result = spawnSync('terraform', ['apply', '-auto-approve'], {
      cwd: tfDir,
      stdio: 'inherit',
      env: { ...process.env, TF_CLI_ARGS: '-input=false' },
    });
    if (result.status !== 0) {
      console.error('[deploy] terraform apply failed.');
      console.error('  Review the output above. Common causes: missing provider credentials,');
      console.error('  resource already exists (import with `terraform import`), or missing tfvars.');
      console.error('  Run `terraform plan` in deploy/terraform/ to see the diff before applying.');
      process.exit(1);
    }
  }
} else if (!runTf && !noTf) {
  console.log('[deploy] Skipping Terraform (pass --terraform <dir> to enable or --no-terraform to suppress this message)');
}

console.log('[deploy] Done.');
