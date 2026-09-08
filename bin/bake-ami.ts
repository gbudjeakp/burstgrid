#!/usr/bin/env node
/**
 * burstgrid bake-ami — build a worker AMI via Packer with Firecracker, the
 * GitHub Actions runner, vmlinux, and rootfs.img pre-baked in. This is the
 * recommended default: workers boot from this AMI and skip the S3 downloads
 * that `userdata.sh.tpl` otherwise falls back to on every launch.
 *
 * Usage:
 *   burstgrid bake-ami --source-ami ami-xxxxxxxx
 *   burstgrid bake-ami --source-ami ami-xxxxxxxx --bucket my-bucket --region us-east-1
 *
 * Requires:
 *   - packer (https://developer.hashicorp.com/packer/install)
 *   - rootfs-arm64.img.gz + vmlinux-aarch64 already uploaded to the S3 bucket
 *     (run `burstgrid build --push` first, or scripts/build-rootfs.sh manually)
 *
 * On success, writes the new AMI ID into deploy/terraform/terraform.tfvars'
 * worker_ami field so the next `burstgrid deploy` picks it up.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bucketFromTfvars } from '../src/build/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

function bail(...lines: string[]): never {
  console.error('\n[bake-ami] ' + lines[0]);
  for (const l of lines.slice(1)) console.error(l);
  process.exit(1);
}

const tfDir = path.join(root, 'deploy', 'terraform');
const sourceAmi = opt('source-ami');
const bucket = opt('bucket') ?? process.env.BURSTGRID_S3_BUCKET ?? bucketFromTfvars(tfDir);
const region = opt('region') ?? process.env.AWS_REGION ?? 'us-east-1';

if (!sourceAmi) {
  bail(
    'Missing --source-ami.',
    '  Pass the stock Ubuntu 24.04 ARM64 AMI to build from (the same one used for scheduler_ami/worker_ami before baking).',
  );
}
if (!bucket) {
  bail(
    'Could not determine S3 bucket.',
    '  Pass --bucket <name>, set BURSTGRID_S3_BUCKET, or run `npx burstgrid setup` first.',
  );
}

const packerCheck = spawnSync('packer', ['--version'], { encoding: 'utf-8' });
if (packerCheck.error) {
  bail(
    'Packer not found.',
    '  Install it: https://developer.hashicorp.com/packer/install',
  );
}

const packerDir = path.join(root, 'deploy', 'packer');
const templatePath = path.join(packerDir, 'worker-ami.pkr.hcl');
const manifestPath = path.join(packerDir, 'manifest.json');
fs.rmSync(manifestPath, { force: true });

console.log('\n[bake-ami] packer init...');
spawnSync('packer', ['init', templatePath], { stdio: 'inherit' });

console.log(`[bake-ami] packer build (region=${region}, bucket=${bucket}, source=${sourceAmi})...\n`);
const build = spawnSync('packer', [
  'build',
  '-var', `region=${region}`,
  '-var', `source_ami=${sourceAmi}`,
  '-var', `s3_artifacts_bucket=${bucket}`,
  templatePath,
], { stdio: 'inherit', cwd: packerDir });

if (build.status !== 0) {
  bail('Packer build failed — see output above.');
}

if (!fs.existsSync(manifestPath)) {
  console.warn('\n[bake-ami] Build finished but manifest.json was not found — check the AMI ID in the Packer output above and set worker_ami manually.');
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { builds: Array<{ artifact_id: string }> };
const artifactId = manifest.builds.at(-1)?.artifact_id ?? '';
const amiId = artifactId.split(':').at(-1) ?? '';

if (!amiId) {
  console.warn('\n[bake-ami] Could not parse AMI ID from manifest.json — set worker_ami manually.');
  process.exit(0);
}

const tfvarsPath = path.join(tfDir, 'terraform.tfvars');
if (fs.existsSync(tfvarsPath)) {
  const content = fs.readFileSync(tfvarsPath, 'utf-8');
  const updated = /^worker_ami\s*=/m.test(content)
    ? content.replace(/^worker_ami\s*=.*$/m, `worker_ami          = "${amiId}"`)
    : `${content}\nworker_ami          = "${amiId}"\n`;
  fs.writeFileSync(tfvarsPath, updated, 'utf-8');
  console.log(`\n[bake-ami] Baked ${amiId} and wrote it to ${path.relative(root, tfvarsPath)}`);
} else {
  console.log(`\n[bake-ami] Baked ${amiId} — no terraform.tfvars found, set worker_ami manually.`);
}
console.log('[bake-ami] Run `npx burstgrid deploy` to roll it out.\n');
