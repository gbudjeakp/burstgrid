import os from 'node:os';
import { WorkerAgent } from '../src/worker/agent.js';
import { loadConfig } from '../src/config/index.js';

const cfg = loadConfig();

const {
  BURSTGRID_SCHEDULER_URL = 'http://localhost:8080',
  BURSTGRID_WORKER_ID = os.hostname(),
  BURSTGRID_SLOTS = '8',
  BURSTGRID_VCPUS = '16',
  BURSTGRID_MEMORY_MIB = '32768',
  // Comma-separated capability labels — add custom labels here (e.g. 'linux,x86_64,docker,gpu')
  BURSTGRID_CAPABILITIES = 'linux,x86_64,docker',
  BURSTGRID_VM_IMAGE = '/var/lib/burstgrid/runner.img',
  BURSTGRID_KERNEL = '/var/lib/burstgrid/vmlinux',
  // 'firecracker' (default), 'process' (bare-metal/GPU), or 'simulate' (local dev)
  BURSTGRID_MODE = 'firecracker',
  BURSTGRID_IMAGE_DIR,
  BURSTGRID_RUNNER_PATH,
  // Pull-through registry mirror — set to http://<host>:5000 to cache Docker Hub pulls
  BURSTGRID_REGISTRY_MIRROR = cfg.worker?.registryMirror,
} = process.env;

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

const agent = new WorkerAgent({
  schedulerUrl: BURSTGRID_SCHEDULER_URL,
  workerId: BURSTGRID_WORKER_ID,
  maxSlots: Number(BURSTGRID_SLOTS),
  totalVcpus: Number(BURSTGRID_VCPUS),
  totalMemoryMiB: Number(BURSTGRID_MEMORY_MIB),
  capabilities: BURSTGRID_CAPABILITIES.split(',').map(s => s.trim()).filter(Boolean),
  vmImagePath: BURSTGRID_VM_IMAGE,
  kernelPath: BURSTGRID_KERNEL,
  mode: BURSTGRID_MODE as 'firecracker' | 'process' | 'simulate',
  imageDir: BURSTGRID_IMAGE_DIR,
  runnerPath: BURSTGRID_RUNNER_PATH,
  registryMirror: BURSTGRID_REGISTRY_MIRROR,
});

try {
  await agent.run(controller.signal);
} catch (err) {
  if (!controller.signal.aborted) {
    console.error('[worker-agent] fatal error', err);
    process.exit(1);
  }
}
