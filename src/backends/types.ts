import type { Job, ExecutionTier } from '../types/index.js';

export interface WorkerSnapshot {
  workerId: string;
  instanceId: string;
  region: string;
  availabilityZone: string;
  totalSlots: number;
  totalVcpus: number;
  totalMemoryMiB: number;
  capabilities: string[];
  freeSlots: number;
  freeVcpus: number;
  freeMemoryMiB: number;
  lastSeen: number; // unix ms
}

export interface IQueueBackend {
  enqueue(job: Job): Promise<void>;
  removeById(jobId: string): Promise<void>;
  requeue(job: Job): Promise<void>;
  depth(): Promise<number>;
  jobs(): AsyncGenerator<Job>;
  subscribeJobNotifications(fn: () => void): Promise<void>;
  close(): Promise<void>;
}

export interface IWorkerRegistryBackend {
  upsert(snapshot: WorkerSnapshot): Promise<void>;
  remove(workerId: string): Promise<void>;
  close(): Promise<void>;
}

export interface JobEvent {
  jobId: string;
  status: 'queued' | 'dispatched' | 'completed' | 'failed';
  workerId?: string;
  owner: string;
  repo: string;
  runId: number;
  tier: ExecutionTier;
  labels: string[];
  timestamp: Date;
  dispatchLatencyMs?: number;
}

export interface IJobHistoryBackend {
  record(event: JobEvent): Promise<void>;
  close(): Promise<void>;
}
