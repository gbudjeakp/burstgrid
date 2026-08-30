/**
 * Pre-boots N blank Firecracker VMs, snapshots them at the "waiting for MMDS token" state,
 * and serves restore paths on demand. Replaces ~150ms cold boots with ~5ms snapshot restores.
 */
import path from 'node:path';
import { FirecrackerVM, type SnapshotPaths, type VMConfig } from './firecracker.js';

export interface SnapshotPoolConfig {
  /** Number of pre-warmed snapshots to keep ready. Default: 2. */
  poolSize?: number;
  /** Directory to store snapshot files. Default: /opt/burstgrid/snapshots. */
  snapshotDir?: string;
  /** Passed directly to the blank VM (no token — MMDS mode only). */
  vmBase: Omit<VMConfig, 'runnerToken' | 'runnerLabels' | 'mmdsMode'>;
}

export class SnapshotPool {
  private readonly poolSize: number;
  private readonly snapshotDir: string;
  private readonly vmBase: SnapshotPoolConfig['vmBase'];
  private readonly ready: SnapshotPaths[] = [];
  private sequence = 0;
  private warming = false;

  constructor(cfg: SnapshotPoolConfig) {
    this.poolSize = cfg.poolSize ?? 2;
    this.snapshotDir = cfg.snapshotDir ?? '/opt/burstgrid/snapshots';
    this.vmBase = cfg.vmBase;
  }

  /** Boot poolSize blank VMs, snapshot them, and queue the paths. */
  async warmUp(): Promise<void> {
    await Promise.all(
      Array.from({ length: this.poolSize }, (_, i) => this.createOne(`warmup-${i}`)),
    );
    console.info(`[snapshot-pool] ${this.ready.length} snapshot(s) ready`);
  }

  /**
   * Acquire snapshot paths for the next job.
   * If the pool is depleted, synchronously creates a fresh snapshot (one cold-boot).
   */
  async acquire(): Promise<SnapshotPaths> {
    if (this.ready.length > 0) {
      const paths = this.ready.shift()!;
      // Replenish in the background — don't await
      void this.replenish();
      return paths;
    }
    console.warn('[snapshot-pool] pool empty — cold-booting a new snapshot (consider raising poolSize)');
    return this.createOne(`ondemand-${this.sequence++}`);
  }

  private async replenish(): Promise<void> {
    if (this.warming) return;
    this.warming = true;
    try {
      while (this.ready.length < this.poolSize) {
        const paths = await this.createOne(`replenish-${this.sequence++}`);
        this.ready.push(paths);
      }
    } finally {
      this.warming = false;
    }
  }

  private async createOne(id: string): Promise<SnapshotPaths> {
    const vmCfg: VMConfig = {
      ...this.vmBase,
      vmId: `bg-snap-${id}`,
      runnerToken: '',
      runnerLabels: '',
      mmdsMode: true,
    };
    const vm = new FirecrackerVM(vmCfg);
    // Boot until the guest init is polling MMDS for its token (the pause point)
    await vm.boot();

    const paths: SnapshotPaths = {
      snapshotPath: path.join(this.snapshotDir, `${id}.snap`),
      memFilePath: path.join(this.snapshotDir, `${id}.mem`),
    };
    await vm.createSnapshot(paths);
    await vm.shutdown();
    return paths;
  }
}
