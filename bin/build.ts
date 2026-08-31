#!/usr/bin/env node
/**
 * burstgrid build — build a Firecracker rootfs image from a Dockerfile and
 * optionally upload it to S3.
 *
 * Usage:
 *   burstgrid build <Dockerfile>
 *   burstgrid build <Dockerfile> --push
 *
 * Options:
 *   --name   <name>   Image name (default: parent directory of Dockerfile)
 *   --out    <path>   Output .img path (default: $TMPDIR/burstgrid-images/<name>.img)
 *   --size   <size>   Image size, e.g. 2G, 4G (default: 2G)
 *   --push            Upload to S3 after build
 *   --bucket <name>   S3 bucket (falls back to BURSTGRID_S3_BUCKET or terraform.tfvars)
 *   --prefix <key>    S3 key prefix (default: rootfs/)
 *   --region <name>   AWS region (default: us-east-1 or AWS_REGION)
 *   --dry-run         Show what would happen without doing it
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveImageName, resolveOutputPath, resolveS3Key, bucketFromTfvars } from '../src/build/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
function flag(name: string) { return args.includes(`--${name}`); }
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}
const positional = args.filter(a => !a.startsWith('-') && args[args.indexOf(a) - 1] !== '--name'
  && args[args.indexOf(a) - 1] !== '--out' && args[args.indexOf(a) - 1] !== '--size'
  && args[args.indexOf(a) - 1] !== '--bucket' && args[args.indexOf(a) - 1] !== '--prefix'
  && args[args.indexOf(a) - 1] !== '--region');

const dockerfilePath = positional[0];
if (!dockerfilePath) {
  console.error('[build] Usage: burstgrid build <Dockerfile> [options]\n  Run `burstgrid build --help` for options.');
  process.exit(1);
}
if (!fs.existsSync(dockerfilePath)) {
  console.error(`[build] Dockerfile not found: ${dockerfilePath}`);
  process.exit(1);
}

const dryRun = flag('dry-run');
const push   = flag('push');
const name   = opt('name') ?? resolveImageName(dockerfilePath);
const out    = resolveOutputPath(name, opt('out'));
const size   = opt('size') ?? '2G';
const prefix = opt('prefix') ?? 'rootfs/';
const region = opt('region') ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const bucket = push
  ? (opt('bucket') ?? process.env.BURSTGRID_S3_BUCKET ?? bucketFromTfvars(path.join(root, 'deploy', 'terraform')))
  : undefined;

if (push && !bucket) {
  console.error(
    '[build] --push requires a bucket.\n' +
    '  Use --bucket <name>, set BURSTGRID_S3_BUCKET, or add s3_artifacts_bucket to deploy/terraform/terraform.tfvars',
  );
  process.exit(1);
}

console.log(`[build] image=${name} size=${size}${push ? ` bucket=${bucket} prefix=${prefix}` : ''}`);
if (dryRun) console.log('[build] dry-run — no changes will be made');

// ── Preflight checks ──────────────────────────────────────────────────────────

function toolAvailable(cmd: string): boolean {
  return !spawnSync(cmd, ['--version'], { encoding: 'utf-8' }).error;
}

function bail(msg: string, fix?: string): never {
  console.error(`[build] ${msg}`);
  if (fix) console.error(`  Fix: ${fix}`);
  process.exit(1);
}

if (!toolAvailable('docker')) {
  bail('docker not found.', 'Install Docker: https://docs.docker.com/get-docker/');
}

// mkfs.ext4 lives in e2fsprogs and doesn't have --version; test with --help
const ext4Check = spawnSync('mkfs.ext4', ['--help'], { encoding: 'utf-8' });
if (ext4Check.error) {
  bail('mkfs.ext4 not found.', 'Install e2fsprogs: sudo apt-get install e2fsprogs  (or brew install e2fsprogs on macOS)');
}

const buildScript = path.join(root, 'scripts', 'build-rootfs.sh');
if (!fs.existsSync(buildScript)) {
  bail(`scripts/build-rootfs.sh not found at ${buildScript}.`, 'Make sure you are running from the burstgrid repo root.');
}

if (push && !toolAvailable('aws')) {
  bail('AWS CLI not found (required for --push).', 'Install it: https://aws.amazon.com/cli/');
}

// ── Build ─────────────────────────────────────────────────────────────────────

console.log(`[build] Building Docker image from ${dockerfilePath}…`);
if (!dryRun) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const result = spawnSync('bash', [buildScript, dockerfilePath, out, size], {
    stdio: 'inherit',
    cwd: root,
  });
  if (result.error) bail(`Failed to run build-rootfs.sh: ${result.error.message}`);
  if (result.status !== 0) {
    bail(
      'build-rootfs.sh exited with non-zero status.',
      'Check the output above. Common causes: docker not running, Dockerfile error, insufficient disk space.',
    );
  }
}

const imgSize = !dryRun && fs.existsSync(out)
  ? (() => {
      const r = spawnSync('du', ['-sh', out], { encoding: 'utf-8' });
      return r.stdout.split('\t')[0] ?? '?';
    })()
  : size;

console.log(`[build] done → ${out} (${imgSize} on disk)`);

// ── Upload ────────────────────────────────────────────────────────────────────

if (push) {
  const key    = resolveS3Key(name, prefix);
  const s3Uri  = `s3://${bucket}/${key}`;
  console.log(`[build] upload ${path.relative(root, out)} → ${s3Uri}`);
  if (!dryRun) {
    const result = spawnSync('aws', ['s3', 'cp', out, s3Uri, '--region', region], { stdio: 'inherit' });
    if (result.status !== 0) {
      const hint = result.stderr?.toString().trim().split('\n')[0] ?? '';
      console.error(`[build] Upload failed.`);
      if (hint) console.error(`  ${hint}`);
      console.error('  Check that the bucket exists and your IAM role has s3:PutObject permission.');
      process.exit(1);
    }
  }
}

console.log('[build] Done.');
if (push) {
  console.log(`\nNext: copy the image to each worker, then register it in burstgrid.config.yaml:`);
  console.log(`  ssh worker-01 "aws s3 cp s3://${bucket}/${resolveS3Key(name, prefix)} /opt/images/"`);
  console.log(`  # Then add worker.images entry with path: /opt/images/${name}.img`);
}
