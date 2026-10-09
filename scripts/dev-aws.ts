#!/usr/bin/env -S node --import tsx
/**
 * One-command local dev environment: starts Floci (a local AWS emulator), seeds the AWS
 * resources BurstGrid's Terraform would create in production (EC2 launch template + security
 * group, IAM role/instance profile, SSM secrets, S3 cache bucket, SQS queues, DynamoDB table,
 * an ALB in front of the scheduler, a CloudTrail trail), then runs the scheduler and worker
 * agent as hot-reloaded local processes (tsx watch) pointed at all of it.
 *
 * Usage: pnpm dev:aws   (or `make dev-aws`)
 * Idempotent — safe to re-run; resource creation calls swallow "already exists" errors.
 */
import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EC2Client, DescribeSubnetsCommand, CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand, CreateLaunchTemplateCommand, DescribeLaunchTemplatesCommand } from '@aws-sdk/client-ec2';
import { IAMClient, CreateRoleCommand, CreateInstanceProfileCommand, AddRoleToInstanceProfileCommand } from '@aws-sdk/client-iam';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { SQSClient, CreateQueueCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { ElasticLoadBalancingV2Client, CreateLoadBalancerCommand, CreateTargetGroupCommand, CreateListenerCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { CloudTrailClient, CreateTrailCommand, StartLoggingCommand } from '@aws-sdk/client-cloudtrail';

const REGION = 'us-east-1';
process.env.AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
process.env.AWS_REGION = REGION;
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';

/** Idempotency helper — resource-already-exists errors are expected on re-runs, not failures. */
async function createIfMissing<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const result = await fn();
    console.log(`  created: ${label}`);
    return result;
  } catch (err) {
    // AWS error shapes vary by service — "already exists" isn't the only phrasing (EC2 uses
    // "already in use" for launch templates) — check the error code too, not just the message.
    const e = err as { name?: string; message?: string; Code?: string };
    const text = [e.name, e.message, e.Code].filter(Boolean).join(' ');
    if (/already exists|AlreadyExists|EntityAlreadyExists|BucketAlreadyOwnedByYou|QueueAlreadyExists|ResourceInUse|TrailAlreadyExists|already in use/i.test(text)) {
      console.log(`  exists:  ${label}`);
      return null;
    }
    throw err;
  }
}

/** Same spirit, but for capabilities Floci may not emulate in every version — skip, don't fail the bootstrap. */
async function createIfAvailable<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await createIfMissing(label, fn);
  } catch (err) {
    console.warn(`  skipped (not available in this Floci version): ${label} — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function waitForFloci(): Promise<void> {
  const ec2 = new EC2Client({ region: REGION });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await ec2.send(new DescribeSubnetsCommand({}));
      ec2.destroy();
      return;
    } catch {
      await new Promise(r => setTimeout(r, 1_000));
    }
  }
  throw new Error('Floci did not become ready within 60s — is Docker running?');
}

async function seedResources() {
  const ec2 = new EC2Client({ region: REGION });
  const iam = new IAMClient({ region: REGION });
  const ssm = new SSMClient({ region: REGION });
  const s3 = new S3Client({ region: REGION, forcePathStyle: true });
  const sqs = new SQSClient({ region: REGION, useQueueUrlAsEndpoint: false });
  const dynamo = new DynamoDBClient({ region: REGION });
  const elb = new ElasticLoadBalancingV2Client({ region: REGION });
  const cloudtrail = new CloudTrailClient({ region: REGION });

  console.log('Seeding AWS resources into Floci...');

  // IAM — mirrors the worker instance profile Terraform attaches in production.
  await createIfMissing('IAM role burstgrid-worker-role', () => iam.send(new CreateRoleCommand({
    RoleName: 'burstgrid-worker-role',
    AssumeRolePolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    }),
  })));
  await createIfMissing('IAM instance profile burstgrid-worker-profile', () => iam.send(new CreateInstanceProfileCommand({
    InstanceProfileName: 'burstgrid-worker-profile',
  })));
  await createIfMissing('attach role to instance profile', () => iam.send(new AddRoleToInstanceProfileCommand({
    InstanceProfileName: 'burstgrid-worker-profile',
    RoleName: 'burstgrid-worker-role',
  })));

  // SSM — same param names/prefix the Terraform `secret_source = "ssm"` path reads in production.
  await createIfMissing('SSM /burstgrid/webhook-secret', () => ssm.send(new PutParameterCommand({
    Name: '/burstgrid/webhook-secret', Type: 'SecureString', Overwrite: true,
    Value: randomBytes(16).toString('hex'),
  })));
  await createIfMissing('SSM /burstgrid/worker-token', () => ssm.send(new PutParameterCommand({
    Name: '/burstgrid/worker-token', Type: 'SecureString', Overwrite: true,
    Value: randomBytes(16).toString('hex'),
  })));

  // EC2 — default VPC/subnets are auto-seeded by Floci; create the security group + launch
  // template a worker fleet needs, so Autoscaler.triggerEvaluation() can actually launch something.
  const { Subnets } = await ec2.send(new DescribeSubnetsCommand({}));
  const subnetIds = (Subnets ?? []).map(s => s.SubnetId!).filter(Boolean);
  const vpcId = Subnets?.[0]?.VpcId!;

  const sg = await createIfMissing('security group burstgrid-dev-sg', () => ec2.send(new CreateSecurityGroupCommand({
    GroupName: 'burstgrid-dev-sg', Description: 'BurstGrid local dev', VpcId: vpcId,
  })));
  const sgId = sg?.GroupId;
  if (sgId) {
    await createIfMissing('security group ingress (8080, 22)', () => ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: [
        { IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
        { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
      ],
    })));
  }
  const lt = await createIfMissing('launch template burstgrid-dev-worker-template', () => ec2.send(new CreateLaunchTemplateCommand({
    LaunchTemplateName: 'burstgrid-dev-worker-template',
    LaunchTemplateData: {
      ImageId: 'ami-alpine', // smallest catalog image — fast to pull
      InstanceType: 't3.micro',
      IamInstanceProfile: { Name: 'burstgrid-worker-profile' },
      ...(sgId ? { SecurityGroupIds: [sgId] } : {}),
    },
  })));
  // createIfMissing returns null on "already exists" (reruns) — look the existing one up instead.
  let launchTemplateId = lt?.LaunchTemplate?.LaunchTemplateId;
  if (!launchTemplateId) {
    const { LaunchTemplates } = await ec2.send(new DescribeLaunchTemplatesCommand({
      LaunchTemplateNames: ['burstgrid-dev-worker-template'],
    }));
    launchTemplateId = LaunchTemplates?.[0]?.LaunchTemplateId;
  }

  // S3 / SQS / DynamoDB — the backends BurstGrid's own code talks to directly.
  await createIfMissing('S3 bucket burstgrid-dev-cache', () => s3.send(new CreateBucketCommand({ Bucket: 'burstgrid-dev-cache' })));
  const jobsQueue = await createIfMissing('SQS queue burstgrid-dev-jobs', () => sqs.send(new CreateQueueCommand({ QueueName: 'burstgrid-dev-jobs' })));
  const spotQueue = await createIfMissing('SQS queue burstgrid-dev-spot-signals', () => sqs.send(new CreateQueueCommand({ QueueName: 'burstgrid-dev-spot-signals' })));
  await createIfMissing('DynamoDB table burstgrid-dev-jobs', () => dynamo.send(new CreateTableCommand({
    TableName: 'burstgrid-dev-jobs',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  })));

  // ALB — mirrors `scheduler_ha_enabled = true`. Needs 2+ subnets in different AZs, same as real
  // ALB; skipped gracefully if this Floci version doesn't emulate ELB v2.
  await createIfAvailable('ALB burstgrid-dev-alb', async () => {
    const lb = await elb.send(new CreateLoadBalancerCommand({
      Name: 'burstgrid-dev-alb', Subnets: subnetIds, Type: 'application',
    }));
    const lbArn = lb.LoadBalancers?.[0]?.LoadBalancerArn;
    const tg = await elb.send(new CreateTargetGroupCommand({
      Name: 'burstgrid-dev-tg', Protocol: 'HTTP', Port: 8080, VpcId: vpcId, TargetType: 'instance',
    }));
    const tgArn = tg.TargetGroups?.[0]?.TargetGroupArn;
    if (lbArn && tgArn) {
      await elb.send(new CreateListenerCommand({
        LoadBalancerArn: lbArn, Protocol: 'HTTP', Port: 80,
        DefaultActions: [{ Type: 'forward', TargetGroupArn: tgArn }],
      }));
    }
    return lb;
  });

  // CloudTrail — optional local parity check for the audit-logging story; skipped gracefully too.
  await createIfAvailable('CloudTrail trail burstgrid-dev-trail', async () => {
    await cloudtrail.send(new CreateTrailCommand({ Name: 'burstgrid-dev-trail', S3BucketName: 'burstgrid-dev-cache' }));
    return cloudtrail.send(new StartLoggingCommand({ Name: 'burstgrid-dev-trail' }));
  });

  for (const c of [ec2, iam, ssm, s3, sqs, dynamo, elb, cloudtrail]) c.destroy();

  return {
    sqsQueueUrl: jobsQueue!.QueueUrl!,
    spotQueueUrl: spotQueue!.QueueUrl!,
    launchTemplateId: launchTemplateId!,
    subnetIds,
  };
}

async function main() {
  console.log('Starting Floci...');
  execSync('docker compose -f docker-compose.dev.yml up -d floci', { stdio: 'inherit' });

  console.log('Waiting for Floci to be ready...');
  await waitForFloci();

  const { sqsQueueUrl, spotQueueUrl, launchTemplateId, subnetIds } = await seedResources();

  Object.assign(process.env, {
    BURSTGRID_SQS_QUEUE_URL: sqsQueueUrl,
    BURSTGRID_SQS_REGION: REGION,
    BURSTGRID_SPOT_QUEUE_URL: spotQueueUrl,
    BURSTGRID_DYNAMODB_TABLE: 'burstgrid-dev-jobs',
    BURSTGRID_DYNAMODB_REGION: REGION,
    BURSTGRID_WEBHOOK_SECRET: process.env.BURSTGRID_WEBHOOK_SECRET ?? '',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? 'local-dev-placeholder-token',
    BURSTGRID_SCHEDULER_URL: 'http://localhost:8080',
    BURSTGRID_MODE: process.env.BURSTGRID_MODE ?? 'simulate',
    // BURSTGRID_FLEETS wins over burstgrid.config.yaml's autoscaler.fleets (which ships with
    // placeholder lt-REPLACE_ME IDs for `npx burstgrid init`) — without this override the
    // autoscaler tries to launch against a launch template that doesn't exist in Floci.
    BURSTGRID_FLEETS: JSON.stringify([{
      name: 'default',
      sizeTag: '',
      launchTemplateId,
      subnetIds,
      maxWorkers: 2,
      slotsPerWorker: 4,
      scaleUpThreshold: 1,
      capacityType: 'on-demand',
    }]),
  });

  console.log('\nResources ready. Launching scheduler + worker agent (hot reload)...\n');
  if (process.env.GITHUB_TOKEN === 'local-dev-placeholder-token') {
    console.log('  note: using a placeholder GITHUB_TOKEN — export a real one for actual webhook/API testing.\n');
  }

  const child = spawn(
    'pnpm exec concurrently -k -n scheduler,worker -c blue,green "tsx watch bin/scheduler.ts" "tsx watch bin/worker-agent.ts"',
    { stdio: 'inherit', env: process.env, shell: true },
  );
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', code => process.exit(code ?? 0));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
