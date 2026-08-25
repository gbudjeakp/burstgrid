import { FirecrackerVM, type VMConfig } from './firecracker.js';
import { vmSizeFromLabels } from '../types/index.js';

export interface SlotConfig {
  jobId: string;
  vmImagePath: string;
  kernelPath: string;
}

export class Slot {
  private vm: FirecrackerVM | null = null;

  constructor(private readonly cfg: SlotConfig) {}

  async start(runnerToken: string, labels: string[]): Promise<void> {
    const { memoryMiB, vcpus } = vmSizeFromLabels(labels);
    const vmCfg: VMConfig = {
      vmId: `bg-${this.cfg.jobId.slice(0, 8)}`,
      kernelPath: this.cfg.kernelPath,
      rootfsPath: this.cfg.vmImagePath,
      memoryMiB,
      vcpus,
      runnerToken,
      runnerLabels: labels.join(','),
    };
    this.vm = new FirecrackerVM(vmCfg);
    await this.vm.boot();
  }

  async wait(): Promise<void> {
    if (!this.vm) throw new Error('slot not started');
    return this.vm.wait();
  }

  async destroy(): Promise<void> {
    await this.vm?.shutdown();
    this.vm = null;
  }
}
