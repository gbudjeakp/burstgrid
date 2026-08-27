import { EC2Client, RunInstancesCommand, type _InstanceType, type InstanceMarketOptionsRequest } from '@aws-sdk/client-ec2';
import type { WorkerPool } from '../scheduler/worker-pool.js';
import type { JobQueue } from '../scheduler/queue.js';

export interface TierFleet {
  /** Human-readable name for logging (e.g. 'standard', 'large', 'xlarge'). */
  name: string;
  /**
   * Worker capability tag this fleet serves (e.g. 'burstgrid:size=large').
   * Leave empty for the default fleet, which handles jobs without a size label.
   */
  sizeTag: string;
  launchTemplateId: string;
  subnetIds: string[];
  maxWorkers: number;
  /** Expected concurrent jobs per worker — used to calculate how many new workers to launch. */
  slotsPerWorker: number;
  scaleUpThreshold: number;
  /**
   * Pre-baked GPU AMI ID to use instead of the Launch Template's default AMI.
   * Set this for gpu-ai fleets so workers boot with CUDA + ML frameworks pre-cached.
   */
  gpuAmiId?: string;
  /** EC2 instance type override for this fleet (e.g. 'g4dn.xlarge', 'p3.2xlarge'). */
  instanceType?: string;
  /** 'spot' uses EC2 spot market; 'on-demand' (default) launches regular instances. */
  capacityType?: 'spot' | 'on-demand';
}

export class Autoscaler {
  private readonly ec2: EC2Client;
  private subnetCursors = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: WorkerPool,
    private readonly queue: JobQueue,
    private readonly fleets: TierFleet[],
    private readonly evaluationIntervalMs = 30_000,
  ) {
    this.ec2 = new EC2Client({});
  }

  start(): void {
    this.timer = setInterval(() => void this.evaluate(), this.evaluationIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async evaluate(): Promise<void> {
    for (const fleet of this.fleets) {
      await this.evaluateFleet(fleet);
    }
  }

  private async evaluateFleet(fleet: TierFleet): Promise<void> {
    const pending = this.jobCountForFleet(fleet);
    const freeSlots = this.pool.freeSlotsWithCapability(fleet.sizeTag);
    const workers = this.pool.workersWithCapability(fleet.sizeTag);

    if (pending <= fleet.scaleUpThreshold || workers >= fleet.maxWorkers) return;

    const needed = Math.min(
      Math.ceil((pending - freeSlots) / fleet.slotsPerWorker),
      fleet.maxWorkers - workers,
    );
    if (needed > 0) await this.launchWorkers(needed, fleet);
  }

  private jobCountForFleet(fleet: TierFleet): number {
    const tag = fleet.sizeTag.toLowerCase();
    return [...this.queue.jobs()].filter(j => {
      const labels = j.labels.map(l => l.toLowerCase());
      return tag
        ? labels.includes(tag)
        // Default fleet: jobs without any burstgrid:size= label
        : !labels.some(l => l.startsWith('burstgrid:size='));
    }).length;
  }

  private async launchWorkers(count: number, fleet: TierFleet): Promise<void> {
    if (!fleet.launchTemplateId || fleet.subnetIds.length === 0) {
      console.warn(`[autoscaler] fleet "${fleet.name}" missing template/subnets; scale-up skipped`);
      return;
    }

    const cursor = this.subnetCursors.get(fleet.name) ?? 0;
    for (let i = 0; i < count; i++) {
      const subnetId = fleet.subnetIds[(cursor + i) % fleet.subnetIds.length];
      try {
        const res = await this.ec2.send(new RunInstancesCommand({
          LaunchTemplate: { LaunchTemplateId: fleet.launchTemplateId, Version: '$Latest' },
          SubnetId: subnetId,
          MinCount: 1,
          MaxCount: 1,
          ...(fleet.gpuAmiId ? { ImageId: fleet.gpuAmiId } : {}),
          ...(fleet.instanceType ? { InstanceType: fleet.instanceType as _InstanceType } : {}),
          ...(fleet.capacityType === 'spot'
            ? { InstanceMarketOptions: { MarketType: 'spot' } as InstanceMarketOptionsRequest }
            : {}),
        }));
        const id = res.Instances?.[0]?.InstanceId ?? 'unknown';
        console.info(`[autoscaler] fleet "${fleet.name}": launched ${id} (subnet ${subnetId})`);
      } catch (err) {
        console.error(`[autoscaler] fleet "${fleet.name}": launch failed`, err);
      }
    }
    this.subnetCursors.set(fleet.name, cursor + count);
  }
}
