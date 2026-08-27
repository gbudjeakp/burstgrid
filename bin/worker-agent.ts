import os from 'node:os';
import { WorkerAgent } from '../src/worker/agent.js';
import { detectCapabilities, detectWorkerId } from '../src/worker/detect.js';
import { loadConfig } from '../src/config/index.js';
import { startWorkerHealthServer } from '../src/worker/health.js';

const cfg = loadConfig();

// Auto-detect host capabilities: arch + Docker availability.
// Override any individual label with BURSTGRID_CAPABILITIES.

const {
  BURSTGRID_SCHEDULER_URL = 'http://localhost:8080',
  BURSTGRID_WORKER_ID,
  BURSTGRID_SLOTS,
  BURSTGRID_VCPUS,
  BURSTGRID_MEMORY_MIB,
  BURSTGRID_CAPABILITIES,
  BURSTGRID_VM_IMAGE = '/var/lib/burstgrid/runner.img',
  BURSTGRID_KERNEL = '/var/lib/burstgrid/vmlinux',
  // 'firecracker' (default), 'process' (bare-metal/GPU), or 'simulate' (local dev)
  BURSTGRID_MODE = 'firecracker',
  BURSTGRID_IMAGE_DIR,
  BURSTGRID_RUNNER_PATH,
  // Pull-through registry mirror — set to http://<host>:5000 to cache Docker Hub pulls
  BURSTGRID_REGISTRY_MIRROR = cfg.worker?.registryMirror,
  BURSTGRID_WORKER_TOKEN = '',
  BURSTGRID_HEALTH_PORT = '9090',
} = process.env;

const cpuCount = os.cpus().length;
const totalVcpus   = Number(BURSTGRID_VCPUS   ?? cpuCount);
const totalMemMiB  = Number(BURSTGRID_MEMORY_MIB ?? Math.floor(os.totalmem() / 1024 / 1024));
// Default slots: half the logical CPUs, min 1
const defaultSlots = Math.max(1, Math.floor(cpuCount / 2));
const maxSlots     = Number(BURSTGRID_SLOTS ?? defaultSlots);

const capabilities = (BURSTGRID_CAPABILITIES ?? detectCapabilities().join(','))
  .split(',').map(s => s.trim()).filter(Boolean);

const workerId = BURSTGRID_WORKER_ID ?? await detectWorkerId();

console.info(
  `[worker-agent] id=${workerId} slots=${maxSlots} vcpus=${totalVcpus} ` +
  `mem=${totalMemMiB}MiB caps=${capabilities.join(',')}`,
);

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

const agent = new WorkerAgent({
  schedulerUrl: BURSTGRID_SCHEDULER_URL,
  workerId,
  maxSlots,
  totalVcpus,
  totalMemoryMiB: totalMemMiB,
  capabilities,
  vmImagePath: BURSTGRID_VM_IMAGE,
  kernelPath: BURSTGRID_KERNEL,
  mode: BURSTGRID_MODE as 'firecracker' | 'process' | 'simulate',
  imageDir: BURSTGRID_IMAGE_DIR,
  runnerPath: BURSTGRID_RUNNER_PATH,
  registryMirror: BURSTGRID_REGISTRY_MIRROR,
  workerToken: BURSTGRID_WORKER_TOKEN,
});

const healthServer = startWorkerHealthServer(
  Number(BURSTGRID_HEALTH_PORT),
  () => agent.isReady() && !controller.signal.aborted,
);

try {
  await agent.run(controller.signal);
} catch (err) {
  if (!controller.signal.aborted) {
    console.error('[worker-agent] fatal error', err);
    process.exit(1);
  }
} finally {
  healthServer.close();
}
