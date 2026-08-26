export enum ExecutionTier {
  Standard = 'standard',
  Critical = 'critical',
  HighDensity = 'high-density',
  Overflow = 'overflow',
  GpuAI = 'gpu-ai',
}

export enum JobStatus {
  Queued = 'queued',
  Claimed = 'claimed',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
}

export interface Job {
  id: string;
  owner: string;
  repo: string;
  runId: number;
  labels: string[];
  tier: ExecutionTier;
  queuedAt: Date;
  runnerToken: string;
}

export interface WorkerRegistration {
  workerId: string;
  instanceId: string;
  region: string;
  availabilityZone: string;
  totalSlots: number;
  /** Total vCPUs on the host (sum of all possible VM allocations). */
  totalVcpus: number;
  /** Total host memory in MiB. */
  totalMemoryMiB: number;
  /** Labels this worker can serve (e.g. ['linux', 'x86_64', 'docker']) */
  capabilities: string[];
}

export interface WorkerHeartbeat {
  workerId: string;
  freeSlots: number;
  usedSlots: number;
  freeVcpus: number;
  freeMemoryMiB: number;
}

export interface JobAssignment {
  jobId: string;
  owner: string;
  repo: string;
  runId: number;
  runnerToken: string;
  labels: string[];
  tier: ExecutionTier;
  vcpus: number;
  memoryMiB: number;
  /** Extra env vars from the GpuAmiProfile, forwarded to the runner process. */
  env?: Record<string, string>;
}

export const VM_SIZES: Record<string, { vcpus: number; memoryMiB: number }> = {
  small:    { vcpus: 1,  memoryMiB: 1_024   },
  medium:   { vcpus: 2,  memoryMiB: 2_048   },
  large:    { vcpus: 4,  memoryMiB: 4_096   },
  xlarge:   { vcpus: 8,  memoryMiB: 8_192   },
  '2xlarge': { vcpus: 16, memoryMiB: 32_768  },
  '4xlarge': { vcpus: 32, memoryMiB: 65_536  },
  '8xlarge': { vcpus: 64, memoryMiB: 131_072 },
};

export function vmSizeFromLabels(labels: string[]): { vcpus: number; memoryMiB: number } {
  const tag = labels.find(l => l.toLowerCase().startsWith('burstgrid:size='));
  const key = tag?.slice('burstgrid:size='.length).toLowerCase() ?? 'medium';
  return VM_SIZES[key] ?? VM_SIZES.medium;
}

export interface JobUpdate {
  jobId: string;
  workerId: string;
  status: JobStatus;
  error?: string;
}

/** A named rootfs image entry in the worker image catalog (burstgrid.config.yaml). */
export interface RootfsImage {
  /** The name used in the burstgrid:image=<name> job label. */
  name: string;
  /** Absolute path to the rootfs .img file on the worker host. */
  path: string;
  // ── Optional metadata — documents what is baked into this image ──
  /** Human-readable description shown in logs. */
  description?: string;
  /** Base OS, e.g. 'ubuntu-22.04' or 'alpine-3.19'. */
  os?: string;
  /** Pre-installed tools/packages, e.g. ['docker', 'node', 'python3', 'git']. */
  tools?: string[];
  /** Docker version if the Docker daemon is pre-installed, e.g. '24.0'. */
  dockerVersion?: string;
  /** Language runtimes pre-installed, e.g. { node: '20.x', python: '3.11' }. */
  languages?: Record<string, string>;
  /** Image file size in bytes; informational only. */
  sizeBytes?: number;
}

/**
 * Describes a pre-baked GPU AMI used as the execution environment for gpu-ai jobs.
 * The AMI should have CUDA drivers, ML frameworks, and optionally model weights
 * pre-installed so workers can start jobs without downloading large dependencies.
 */
export interface GpuAmiProfile {
  /** AWS AMI ID, e.g. 'ami-0abc1234'. */
  id: string;
  /** Human-readable name; also used for label matching via burstgrid:gpu-ami=<name>. */
  name: string;
  /** CUDA version pre-installed, e.g. '12.4'. */
  cudaVersion: string;
  /** EC2 instance families this image supports (e.g. ['g4dn', 'g5', 'p3']). */
  instanceFamilies: string[];
  /** Pip packages pre-installed in the image for fast job start. */
  cachedPackages?: string[];
  /** HuggingFace model IDs pre-downloaded into the model cache on the image. */
  cachedModels?: string[];
  /**
   * Whether Docker + NVIDIA Container Toolkit are pre-installed on the AMI.
   * GPU jobs run directly on the EC2 host (not inside a Firecracker VM), so
   * Docker is fully available — containers can access GPUs via --gpus all.
   * Defaults to false; set true if your AMI includes the NVIDIA runtime.
   */
  dockerEnabled?: boolean;
  /** Docker images pre-pulled on the AMI to avoid pull latency on first job. */
  prePulledImages?: string[];
  /** Extra environment variables injected into every job on this host. */
  env?: Record<string, string>;
}
