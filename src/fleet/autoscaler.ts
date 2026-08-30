import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type _InstanceType,
  type InstanceMarketOptionsRequest,
} from '@aws-sdk/client-ec2';
import type { WorkerPool } from '../scheduler/worker-pool.js';
import type { JobQueue } from '../scheduler/queue.js';
import { VM_SIZES, vmSizeFromLabels } from '../types/index.js';

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
  /** Seconds a fully-idle worker must stay quiet before being terminated. Default: 300 (5 min). */
  scaleDownAfterIdleSec?: number;
  /**
   * Total vCPUs on the EC2 instance launched from this fleet (e.g. 8 for m6g.2xlarge).
   * Used by the autoscaler to calculate how many workers to launch to cover vCPU demand.
   * Defaults to slotsPerWorker × vCPUs for the fleet's sizeTag job size.
   */
  instanceVcpus?: number;
}

export class Autoscaler {
  private readonly ec2: EC2Client;
  private subnetCursors = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  // timestamps of launches that haven't registered yet, keyed by fleet name
  private readonly pendingLaunches = new Map<string, number[]>();
  private readonly LAUNCH_TTL_MS = 3 * 60 * 1_000;

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
    await this.scaleDownGlobal();
    await this.scaleUpGlobal();
  }

  /**
   * Terminate workers that have been fully idle longer than the shortest
   * scaleDownAfterIdleSec across all fleets. Keeps one warm standby alive globally.
   */
  private async scaleDownGlobal(): Promise<void> {
    const idleMs = Math.min(...this.fleets.map(f => (f.scaleDownAfterIdleSec ?? 300))) * 1_000;
    // '' tag = all workers regardless of capabilities
    const idle = this.pool.idleWorkers('', idleMs);
    if (idle.length <= 1) return; // keep one warm standby

    const toTerminate = idle.slice(0, idle.length - 1);
    const ids = toTerminate.map(w => w.ec2InstanceId);
    try {
      await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
      console.info(`[autoscaler] terminated ${ids.join(', ')} (idle >${idleMs / 1_000}s)`);
    } catch (err) {
      console.error('[autoscaler] terminate failed', err);
    }
  }

  /**
   * Launch workers to cover total pending vCPU demand.
   * Uses the largest-instance fleet first to minimise instance count (bin packing),
   * capping each fleet at maxWorkers. Workers serve any job size via resource matching.
   */
  private async scaleUpGlobal(): Promise<void> {
    const pendingJobs = [...this.queue.jobs()].filter(j => {
      const labels = j.labels.map(l => l.toLowerCase());
      return !labels.some(l => l === 'completed' || l === 'failed');
    });
    if (pendingJobs.length === 0) return;

    const pendingVcpus = pendingJobs.reduce((s, j) =>
      s + vmSizeFromLabels(j.labels).vcpus, 0);

    if (pendingVcpus <= this.pool.totalFreeVcpus) return;

    let deficit = pendingVcpus - this.pool.totalFreeVcpus;

    // Largest-instance fleets first → fewest instances needed to cover demand
    const sorted = [...this.fleets].sort(
      (a, b) => this.instanceVcpusForFleet(b) - this.instanceVcpusForFleet(a),
    );

    for (const fleet of sorted) {
      if (deficit <= 0) break;
      const pendingWorkers = this.activePendingCount(fleet.name);
      if (pendingWorkers >= fleet.maxWorkers) continue;

      const workerVcpus = this.instanceVcpusForFleet(fleet);
      const needed = Math.min(
        Math.ceil(deficit / workerVcpus),
        fleet.maxWorkers - pendingWorkers,
      );
      if (needed > 0) {
        await this.launchWorkers(needed, fleet);
        deficit -= needed * workerVcpus;
      }
    }
  }

  /** vCPUs provided by one instance of this fleet. */
  private instanceVcpusForFleet(fleet: TierFleet): number {
    if (fleet.instanceVcpus) return fleet.instanceVcpus;
    const sizeKey = fleet.sizeTag.replace(/^burstgrid:size=/i, '');
    return fleet.slotsPerWorker * (VM_SIZES[sizeKey]?.vcpus ?? 2);
  }

  private activePendingCount(fleetName: string): number {
    const now = Date.now();
    const active = (this.pendingLaunches.get(fleetName) ?? []).filter(t => now - t < this.LAUNCH_TTL_MS);
    this.pendingLaunches.set(fleetName, active);
    return active.length;
  }

  private async launchWorkers(count: number, fleet: TierFleet): Promise<void> {
    if (!fleet.launchTemplateId || fleet.subnetIds.length === 0) {
      console.warn(`[autoscaler] fleet "${fleet.name}" missing template/subnets; scale-up skipped`);
      return;
    }

    const cursor = this.subnetCursors.get(fleet.name) ?? 0;
    for (let i = 0; i < count; i++) {
      const subnetId = fleet.subnetIds[(cursor + i) % fleet.subnetIds.length];
      const launched = await this.tryLaunch(fleet, subnetId, fleet.capacityType ?? 'on-demand');
      if (!launched && fleet.capacityType === 'spot') {
        console.warn(`[autoscaler] fleet "${fleet.name}": spot unavailable, retrying on-demand`);
        await this.tryLaunch(fleet, subnetId, 'on-demand');
      }
    }
    this.subnetCursors.set(fleet.name, cursor + count);
  }

  private async tryLaunch(fleet: TierFleet, subnetId: string, capacityType: 'spot' | 'on-demand'): Promise<boolean> {
    try {
      const res = await this.ec2.send(new RunInstancesCommand({
        LaunchTemplate: { LaunchTemplateId: fleet.launchTemplateId, Version: '$Latest' },
        SubnetId: subnetId,
        MinCount: 1,
        MaxCount: 1,
        ...(fleet.gpuAmiId ? { ImageId: fleet.gpuAmiId } : {}),
        ...(fleet.instanceType ? { InstanceType: fleet.instanceType as _InstanceType } : {}),
        ...(capacityType === 'spot'
          ? { InstanceMarketOptions: { MarketType: 'spot' } as InstanceMarketOptionsRequest }
          : {}),
      }));
      const id = res.Instances?.[0]?.InstanceId ?? 'unknown';
      const launches = this.pendingLaunches.get(fleet.name) ?? [];
      launches.push(Date.now());
      this.pendingLaunches.set(fleet.name, launches);
      console.info(`[autoscaler] fleet "${fleet.name}": launched ${id} (subnet ${subnetId}, ${capacityType})`);
      return true;
    } catch (err) {
      console.error(`[autoscaler] fleet "${fleet.name}": launch failed (${capacityType})`, err);
      return false;
    }
  }
}
