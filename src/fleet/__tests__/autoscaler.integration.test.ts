import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FlociContainer, type StartedFlociContainer } from '@floci/testcontainers';
import { EC2Client, DescribeSubnetsCommand, CreateLaunchTemplateCommand, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { Autoscaler, type TierFleet } from '../autoscaler.js';
import { WorkerPool } from '../../scheduler/worker-pool.js';
import { JobQueue } from '../../scheduler/queue.js';
import { ExecutionTier } from '../../types/index.js';

// Runs a real scale-up decision against Floci's Docker-backed EC2 emulation (RunInstances
// actually starts a container) instead of the hand-mocked EC2Client used elsewhere, so a
// malformed RunInstances request can't hide behind a mock that never rejects anything.
describe('Autoscaler (Floci integration)', () => {
  let floci: StartedFlociContainer;
  let originalEnv: Record<string, string | undefined>;
  let subnetId: string;
  let launchTemplateId: string;

  beforeAll(async () => {
    floci = await new FlociContainer().start();

    originalEnv = {
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
      AWS_REGION: process.env.AWS_REGION,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    };
    // Autoscaler builds its own EC2Client with zero config (new EC2Client({})) — same ambient
    // AWS_* env vars it would read when pointed at real AWS.
    process.env.AWS_ENDPOINT_URL = floci.getEndpoint();
    process.env.AWS_REGION = floci.getRegion();
    process.env.AWS_ACCESS_KEY_ID = floci.getAccessKey();
    process.env.AWS_SECRET_ACCESS_KEY = floci.getSecretKey();

    const ec2 = new EC2Client({ region: floci.getRegion() });
    // Floci seeds a default VPC + subnets per region on first use — no setup needed.
    const { Subnets } = await ec2.send(new DescribeSubnetsCommand({}));
    subnetId = Subnets![0].SubnetId!;

    const { LaunchTemplate } = await ec2.send(new CreateLaunchTemplateCommand({
      LaunchTemplateName: 'burstgrid-test-template',
      // ami-alpine maps to the tiny alpine:latest image in Floci's AMI catalog — fastest to pull.
      LaunchTemplateData: { ImageId: 'ami-alpine', InstanceType: 't3.micro' },
    }));
    launchTemplateId = LaunchTemplate!.LaunchTemplateId!;
    ec2.destroy();
  }, 90_000);

  afterAll(async () => {
    process.env.AWS_ENDPOINT_URL = originalEnv.AWS_ENDPOINT_URL;
    process.env.AWS_REGION = originalEnv.AWS_REGION;
    process.env.AWS_ACCESS_KEY_ID = originalEnv.AWS_ACCESS_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = originalEnv.AWS_SECRET_ACCESS_KEY;
    await floci.stop();
  });

  it('launches a real Docker-backed EC2 instance when demand exceeds free capacity', async () => {
    const pool = new WorkerPool();
    const queue = new JobQueue();
    queue.enqueue({
      id: 'job-1',
      owner: 'acme',
      repo: 'widgets',
      runId: 1,
      labels: [],
      tier: ExecutionTier.Standard,
      queuedAt: new Date(),
      runnerToken: 'tok-abc',
    });

    const fleet: TierFleet = {
      name: 'default',
      sizeTag: '',
      launchTemplateId,
      subnetIds: [subnetId],
      maxWorkers: 1,
      slotsPerWorker: 1,
      scaleUpThreshold: 0,
    };
    const autoscaler = new Autoscaler(pool, queue, [fleet]);
    await autoscaler.triggerEvaluation();

    const verify = new EC2Client({ region: floci.getRegion() });
    const { Reservations } = await verify.send(new DescribeInstancesCommand({
      Filters: [{ Name: 'subnet-id', Values: [subnetId] }],
    }));
    verify.destroy();

    const instances = Reservations?.flatMap(r => r.Instances ?? []) ?? [];
    expect(instances).toHaveLength(1);
    expect(['pending', 'running']).toContain(instances[0].State?.Name);
  }, 90_000);
});
