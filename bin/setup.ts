#!/usr/bin/env node
/**
 * burstgrid setup — scaffold deploy/terraform/terraform.tfvars from live AWS resources.
 *
 * Auto-detects your default VPC, first public subnet, and the latest Ubuntu 24.04
 * ARM64 AMI. Generates webhook_secret and worker_token. Writes terraform.tfvars
 * ready for `burstgrid deploy`.
 *
 * Usage:
 *   npx burstgrid setup                     # bucket name derived from account ID
 *   npx burstgrid setup --bucket my-bucket
 *   npx burstgrid setup --region us-west-2
 *   npx burstgrid setup --ami ami-0abc123456789   # skip detection, use this AMI
 *   npx burstgrid setup --force             # overwrite existing terraform.tfvars
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
function flag(name: string) { return args.includes(`--${name}`); }
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

const force  = flag('force');
const region = opt('region') ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const amiOverride = opt('ami');

// ── AWS CLI helper ────────────────────────────────────────────────────────────

function awsCli(cliArgs: string[], failHint: string): string {
  const all = region ? [...cliArgs, '--region', region] : cliArgs;
  const result = spawnSync('aws', all, { encoding: 'utf-8' });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      bail(
        'AWS CLI not found.',
        'Install it: https://aws.amazon.com/cli/',
      );
    }
    bail(`AWS CLI error: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    const lines = [failHint];
    if (stderr) lines.push(`  AWS said: ${stderr.split('\n')[0]}`);
    if (isCredentialError(stderr)) {
      lines.push(
        '  Fix: run `aws configure` or export AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY',
        '  Docs: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-quickstart.html',
      );
    }
    bail(...lines);
  }

  return result.stdout.trim();
}

function isCredentialError(stderr: string) {
  return /Unable to locate credentials|NoCredentialProviders|ExpiredToken|InvalidClientTokenId/i.test(stderr);
}

function bail(...lines: string[]): never {
  console.error('\n[setup] ' + lines[0]);
  for (const l of lines.slice(1)) console.error(l);
  process.exit(1);
}

function ok(label: string, value: string) {
  const tick = '\x1b[32m✓\x1b[0m';
  console.log(`  ${tick} ${label.padEnd(28)} ${value}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('\nBurstGrid setup\n');

// 1. Verify credentials + resolve account ID and region
let identity: { Account: string };
try {
  identity = JSON.parse(awsCli(
    ['sts', 'get-caller-identity', '--output', 'json'],
    'AWS credentials not found or expired.',
  ));
} catch {
  bail(
    'AWS credentials not found or expired.',
    '  Fix: run `aws configure` or export AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY',
  );
}

const accountId      = identity!.Account;
const resolvedRegion = region ?? 'us-east-1';
ok('Account', `${accountId} (${resolvedRegion})`);

// 2. Default VPC
const rawVpc = awsCli(
  ['ec2', 'describe-vpcs',
    '--filters', 'Name=isDefault,Values=true',
    '--query', 'Vpcs[0].VpcId', '--output', 'text'],
  'Could not detect default VPC.',
);
if (!rawVpc || rawVpc === 'None') {
  bail(
    'No default VPC found in ' + resolvedRegion + '.',
    '  Fix: run `aws ec2 create-default-vpc --region ' + resolvedRegion + '`',
    '  Or pass an existing VPC ID with --vpc-id and edit the generated file.',
  );
}
const vpcId = rawVpc;
ok('Default VPC', vpcId);

// 3. First public subnet in the default VPC
const rawSubnet = awsCli(
  ['ec2', 'describe-subnets',
    '--filters', `Name=vpc-id,Values=${vpcId}`, 'Name=map-public-ip-on-launch,Values=true',
    '--query', 'Subnets[0].SubnetId', '--output', 'text'],
  `Could not find a public subnet in ${vpcId}.`,
);
if (!rawSubnet || rawSubnet === 'None') {
  bail(
    `No public subnets found in ${vpcId}.`,
    '  Fix: enable "Auto-assign public IPv4" on a subnet, or create a default subnet:',
    `  aws ec2 create-default-subnet --availability-zone ${resolvedRegion}a`,
  );
}
const subnetId = rawSubnet;
ok('Public subnet', subnetId);

// 4. Latest Ubuntu 24.04 ARM64 AMI (Canonical owner ID 099720109477)
let amiId: string;
if (amiOverride) {
  amiId = amiOverride;
  ok('AMI', amiId);
} else {
  const rawAmi = awsCli(
    ['ec2', 'describe-images',
      '--owners', '099720109477',
      '--filters', 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*',
      '--query', 'sort_by(Images,&CreationDate)[-1].ImageId', '--output', 'text'],
    'Could not find Ubuntu 24.04 ARM64 AMI.',
  );
  if (!rawAmi || rawAmi === 'None') {
    bail(
      `Ubuntu 24.04 ARM64 AMI not found in ${resolvedRegion}.`,
      '  This AMI should exist in every commercial region.',
      '  Fix: check your region spelling, or find the AMI manually at https://cloud-images.ubuntu.com/locator/ec2/',
      '  then edit the generated terraform.tfvars, or pass --ami <id> to skip detection.',
    );
  }
  amiId = rawAmi;
  ok('Ubuntu 24.04 ARM64 AMI', amiId);
}

// 5. S3 bucket name
const bucket = opt('bucket') ?? process.env.BURSTGRID_S3_BUCKET ?? `burstgrid-${accountId}`;
ok('S3 bucket', bucket);

// 6. Optional x86 AMI for mixed-arch fleets
let x86AmiId: string | undefined;
if (!amiOverride) {
  const rawX86Ami = awsCli(
    ['ec2', 'describe-images',
      '--owners', '099720109477',
      '--filters', 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
      '--query', 'sort_by(Images,&CreationDate)[-1].ImageId', '--output', 'text'],
    'Could not find Ubuntu 24.04 x86_64 AMI.',
  );
  if (rawX86Ami && rawX86Ami !== 'None') {
    x86AmiId = rawX86Ami;
    ok('Ubuntu 24.04 x86_64 AMI', x86AmiId);
  }
}
// 7. Generate secrets
const webhookSecret = crypto.randomBytes(24).toString('hex');
const workerToken   = crypto.randomBytes(24).toString('hex');
ok('Webhook secret', '(generated)');
ok('Worker token',   '(generated)');

// ── Write terraform.tfvars ────────────────────────────────────────────────────

const tfDir  = path.join(root, 'deploy', 'terraform');
const out    = path.join(tfDir, 'terraform.tfvars');

if (fs.existsSync(out) && !force) {
  bail(
    `${path.relative(root, out)} already exists.`,
    '  Pass --force to overwrite, or edit it manually.',
  );
}

if (!fs.existsSync(tfDir)) fs.mkdirSync(tfDir, { recursive: true });

fs.writeFileSync(out, [
  `aws_region          = "${resolvedRegion}"`,
  `vpc_id              = "${vpcId}"`,
  `scheduler_subnet_id = "${subnetId}"`,
  `nat_subnet_id       = "${subnetId}"`,
  `scheduler_ami       = "${amiId}"`,
  `worker_ami          = "${amiId}"`,
  ...(x86AmiId ? [`worker_ami_x86     = "${x86AmiId}"  # x86_64 fleet AMI`] : []),
  `s3_artifacts_bucket = "${bucket}"`,
  `webhook_secret      = "${webhookSecret}"`,
  `worker_token        = "${workerToken}"`,
  '',
].join('\n'), 'utf-8');

console.log(`\n  Wrote ${path.relative(root, out)}\n`);
console.log('Next steps:');
console.log('');
console.log('  1. Request AWS vCPU quota increase (required for running multiple workers):');
console.log(`       https://${resolvedRegion}.console.aws.amazon.com/servicequotas/home/services/ec2/quotas`);
console.log('       Search "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances"');
console.log('       Each c6g.metal worker uses 64 vCPUs. Default account limit is often 32-64.');
console.log('       Also request "All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests".');
console.log('');
console.log('  2. Build rootfs images and upload to S3 (run on an ARM64 host with Docker):');
console.log('       # Default rootfs — for standard CI jobs:');
console.log('       ./scripts/build-rootfs.sh rootfs/template/Dockerfile /tmp/rootfs-arm64.img 4G arm64 --compress');
console.log(`       aws s3 cp /tmp/rootfs-arm64.img.gz s3://${bucket}/rootfs-arm64.img.gz`);
console.log('       # Docker-heavy rootfs — for jobs with Docker-in-Docker, databases, etc.:');
console.log('       ./scripts/build-rootfs.sh rootfs/ubuntu-docker/Dockerfile /tmp/rootfs-arm64-ubuntu-docker.img 16G arm64 --compress');
console.log(`       aws s3 cp /tmp/rootfs-arm64-ubuntu-docker.img.gz s3://${bucket}/rootfs-arm64-ubuntu-docker.img.gz`);
console.log('       # Download the Firecracker-compatible ARM64 kernel:');
console.log(`       curl -fsSL https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.9/aarch64/vmlinux-6.1.102 -o /tmp/vmlinux-aarch64`);
console.log(`       aws s3 cp /tmp/vmlinux-aarch64 s3://${bucket}/vmlinux-aarch64`);
console.log('');
console.log('  3. Set GitHub credentials (choose one):');
console.log('       GitHub App (recommended):  export GITHUB_APP_ID=<id> GITHUB_PRIVATE_KEY_PATH=<path>');
console.log('       Personal access token:     export GITHUB_TOKEN=<token>  (fine-grained, repo scope)');
console.log('');
console.log('  4. Deploy infrastructure:');
console.log('       npx burstgrid deploy');
console.log('');
console.log('  5. Populate burstgrid.config.yaml with the new launch template IDs:');
console.log('       npx burstgrid init');
console.log('');
console.log('  6. Register GitHub webhook:');
console.log('       GitHub repo → Settings → Webhooks → Add webhook');
console.log(`       Payload URL:   http://<scheduler-ip>:8080/webhook`);
console.log('       Content type:  application/json');
console.log(`       Secret:        <webhook_secret from deploy/terraform/terraform.tfvars>`);
console.log('       Events:        select "Workflow jobs" (workflow_job)');
console.log('');
