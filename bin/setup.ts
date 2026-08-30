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
    '  then edit the generated terraform.tfvars.',
  );
}
const amiId = rawAmi;
ok('Ubuntu 24.04 ARM64 AMI', amiId);

// 5. S3 bucket name
const bucket = opt('bucket') ?? process.env.BURSTGRID_S3_BUCKET ?? `burstgrid-${accountId}`;
ok('S3 bucket', bucket);

// 6. Generate secrets
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
  `s3_artifacts_bucket = "${bucket}"`,
  `webhook_secret      = "${webhookSecret}"`,
  `worker_token        = "${workerToken}"`,
  '',
].join('\n'), 'utf-8');

console.log(`\n  Wrote ${path.relative(root, out)}\n`);
console.log('Next steps:');
console.log('  1. Set GITHUB_APP_ID + GITHUB_PRIVATE_KEY_PATH on your scheduler instance');
console.log('     (or GITHUB_TOKEN for single-repo testing)');
console.log('  2. npx burstgrid deploy');
console.log('');
