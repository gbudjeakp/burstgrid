# BurstGrid

> **⚠ Work in progress** — nothing has been tested end-to-end. Architecture and APIs will change. Not ready for production use.

CI runner scheduling and execution platform for teams running large-scale GitHub Actions workloads. BurstGrid replaces the EC2-per-job model with **bin-packed Firecracker microVMs**, many isolated jobs per host, dispatched via a central scheduler, each destroyed after completion.

> **Not sure what instance size your jobs actually need?** [RunRight](https://runright.dev) profiles GitHub Actions workflows and recommends the right runner class, so you don't over-provision fleets.

```
GitHub webhook
      │
      ▼
┌──────────────────┐   SSE push (persistent)   ┌──────────────────────────────────────┐
│    Scheduler     │ ─────────────────────────► │  Worker Host (EC2 c7i.4xlarge)       │
│                  │ ◄─────────────────────────  │                                      │
│  job queue       │   heartbeat / status POST  │  slot 0 → Firecracker microVM → job  │
│  worker registry │                             │  slot 1 → Firecracker microVM → job  │
│  circuit breaker │                             │  ...up to N slots                    │
│  autoscaler      │                             └──────────────────────────────────────┘
└──────────────────┘
```

Each worker opens one persistent SSE connection to the scheduler. Jobs are pushed over that stream, no polling, no reconnect per job. Each microVM gets its own kernel, rootfs, and Docker daemon. The VM is destroyed after the job completes.

## How it works (component glossary)

| Component | What it does |
|---|---|
| **Scheduler** | Receives `workflow_job` webhooks from GitHub, validates HMAC signatures, enqueues jobs, dispatches them to workers over SSE, exposes `/v1/status` and `/health`. |
| **Job queue** | In-memory priority queue with four tiers (critical → standard → high-density → overflow). Critical jobs always jump the queue. |
| **Worker registry** | Tracks every connected worker: its EC2 instance ID, total vCPU/memory, current free slots, and active SSE stream. Reaps workers that miss heartbeats for >30 s. |
| **Router** | Drain loop that runs on every `enqueue` event and every 500 ms. Matches jobs to workers by capability labels and available resources, then pushes assignments over the worker's SSE stream. |
| **Circuit breaker** | Guards the GitHub API. After 5 consecutive token-creation failures it opens for 30 s — all webhooks return `503` (GitHub retries for 72 h) instead of hammering a down API. |
| **Autoscaler** | Watches queue depth per fleet every 30 s. When pending jobs exceed free slots + threshold, it calls EC2 `RunInstances` with the fleet's launch template. Workers drain naturally; no forced termination. |
| **Worker agent** | Runs on each EC2 host. Registers with the scheduler, holds the SSE stream, receives job assignments, boots a Firecracker microVM per job, waits for completion, reports status back. |
| **Firecracker VM** | Lightweight VM (~125 ms boot). Each job gets its own kernel + rootfs + Docker daemon. Destroyed after completion — no state bleed between jobs or PRs. |

## Execution tiers

| Tier | Label | Execution model | Use case |
|---|---|---|---|
| `critical` | `burstgrid:critical` | Dedicated EC2 VM per job | Prod deploys, privileged jobs |
| `standard` | _(default)_ | microVM slot on shared worker | Most builds and tests |
| `high-density` | `burstgrid:high-density` | Process/container slot | Trusted, low-risk internal jobs |
| `overflow` | _(no capacity)_ | GitHub-hosted runner | Last-resort safety valve |

Tier is selected by the scheduler from the job's `runs-on` labels. No workflow changes needed — just add a label.

## Quick start (local dev)

```bash
pnpm install

# Scheduler with a GitHub PAT (no App setup required for dev)
GITHUB_TOKEN=ghp_... pnpm dev:scheduler

# Worker agent (connects to local scheduler, skips Firecracker in dev)
BURSTGRID_SCHEDULER_URL=http://localhost:8080 pnpm dev:agent
```

**Receiving webhooks locally:**
```bash
gh webhook forward --repo=owner/repo --events=workflow_job --url=http://localhost:8080/webhook/github
```

## Configuration

### Scheduler environment variables

| Variable | Default | Description |
|---|---|---|
| `BURSTGRID_ADDR` | `0.0.0.0` | Listen address |
| `BURSTGRID_PORT` | `8080` | Listen port |
| `BURSTGRID_WEBHOOK_SECRET` | _(empty)_ | GitHub webhook HMAC secret |
| `BURSTGRID_MAX_QUEUE_DEPTH` | `500` | Max queued jobs before returning 503 |
| `BURSTGRID_LAUNCH_TEMPLATE_ID` | — | Single-fleet fallback launch template |
| `BURSTGRID_SUBNET_IDS` | — | Comma-separated subnet IDs (single-fleet) |
| `BURSTGRID_FLEETS` | — | JSON array of `TierFleet` objects (overrides YAML) |
| `BURSTGRID_CONFIG` | `./burstgrid.config.yaml` | Path to YAML config file |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | Activates OTLP metrics export (see [Observability](#observability)) |
| `GITHUB_APP_ID` | — | GitHub App ID |
| `GITHUB_PRIVATE_KEY_PATH` | — | Path to GitHub App private key PEM |
| `GITHUB_TOKEN` | — | PAT for local dev (overrides App auth) |

### Worker agent environment variables

| Variable | Default | Description |
|---|---|---|
| `BURSTGRID_SCHEDULER_URL` | `http://localhost:8080` | Scheduler address |
| `BURSTGRID_WORKER_ID` | `os.hostname()` | Worker ID (set to EC2 instance-id in prod) |
| `BURSTGRID_SLOTS` | `8` | Max concurrent microVM slots |
| `BURSTGRID_VCPUS` | `16` | Total host vCPUs (must match EC2 instance type) |
| `BURSTGRID_MEMORY_MIB` | `32768` | Total host memory in MiB |
| `BURSTGRID_CAPABILITIES` | `linux,x86_64,docker` | Comma-separated capability labels advertised to scheduler |
| `BURSTGRID_VM_IMAGE` | `/var/lib/burstgrid/runner.img` | Firecracker rootfs image |
| `BURSTGRID_KERNEL` | `/var/lib/burstgrid/vmlinux` | Firecracker kernel image |

**Custom labels** — `BURSTGRID_CAPABILITIES` is how you support team-specific runner labels. A GPU fleet would set `BURSTGRID_CAPABILITIES=linux,x86_64,docker,gpu,cuda-12`. Any workflow using `runs-on: [self-hosted, linux, gpu]` is routed exclusively to those workers.

## Production deployment

See [`deploy/terraform/`](deploy/terraform/) for the full AWS infrastructure.

```bash
make infra-init
make infra-plan
make infra-apply
```

After apply, set the `github_webhook_url` output as your GitHub organization webhook URL and configure the `worker_launch_template_id` output as `BURSTGRID_LAUNCH_TEMPLATE_ID` on the scheduler.

### EC2 instance requirements

Firecracker requires hardware virtualization (KVM). **Worker instances must be metal.** Standard virtualized instances (`c7i.4xlarge`, `m7g.2xlarge`, etc.) will not work — they cannot run nested VMs.

| Architecture | Tested instance families |
|---|---|
| x86\_64 (Intel) | `m5n.metal`, `m6i.metal`, `m7i.metal-*`, `m8i.metal-*` |
| x86\_64 (AMD) | `m6a.metal`, `m7a.metal-48xl` |
| ARM (Graviton) | `m6g.metal`, `m7g.metal`, `m8g.metal-*` |

> **Note:** 8th-gen Intel (`m8i.*`) requires a 6.1 or newer host kernel due to Granite Rapids CPU support.

The scheduler runs on any standard instance (`t3.small` is sufficient). Only workers need metal.

## YAML configuration

The recommended way to configure multi-fleet autoscaling is `burstgrid.config.yaml` at the project root (see [`burstgrid.config.yaml`](burstgrid.config.yaml) for a full annotated example):

```yaml
autoscaler:
  enabled: true           # set false to disable EC2 auto-scaling entirely
  evaluationIntervalSec: 30
  fleets:
    - name: standard
      sizeTag: ""
      launchTemplateId: lt-xxxxxxxxxxxxxxxxx
      subnetIds: [subnet-aaa, subnet-bbb]
      maxWorkers: 50
      slotsPerWorker: 8
      scaleUpThreshold: 4
    - name: xlarge         # for burstgrid:size=xlarge jobs (e.g. monorepo lint)
      sizeTag: burstgrid:size=xlarge
      launchTemplateId: lt-yyyyyyyyyyyyyyy
      subnetIds: [subnet-aaa]
      maxWorkers: 5
      slotsPerWorker: 1
      scaleUpThreshold: 1
```

**Precedence:** `BURSTGRID_FLEETS` env (JSON) → `burstgrid.config.yaml` → `BURSTGRID_LAUNCH_TEMPLATE_ID` env (single-fleet fallback).

### Oversized jobs

If a job requests `burstgrid:size=xlarge` but no fleet is configured with a matching `sizeTag`, the job waits in the queue indefinitely. After 10 minutes the router logs a structured warning:

```
[router] job abc123 queued 10m with no capable workers — check fleet config for size 8vCPU/8192MiB
```

If the host itself is too small (e.g. the fleet's `c7i.2xlarge` has only 8 vCPU but the job needs 32 vCPU), the autoscaler needs to point to a larger launch template. There is no automatic promotion to a bigger instance type — fleet configuration is explicit.

## Building

```bash
pnpm build       # outputs scheduler and worker-agent to dist/
pnpm typecheck   # type-check without building
pnpm test        # run tests
```

## GitHub App setup

1. Create a GitHub App with `Actions: Read & write` permission on repositories.
2. Install the App on your organization.
3. Download the private key PEM.
4. Set `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY_PATH` in the scheduler environment.

## Resilience

### GitHub incidents

When GitHub's API is unavailable, `createRunnerToken` starts failing. BurstGrid handles this with a **circuit breaker**:

- After 5 consecutive failures, the circuit opens for 30 seconds.
- While open, webhook requests immediately return `503` without calling GitHub.
- **`503` is intentional** — GitHub retries failed webhook deliveries for 72 hours. Returning `503` keeps events in GitHub's retry queue so nothing is lost when the API recovers.

The circuit uses a half-open probe: the first request after the cooldown is allowed through. On success, the circuit closes and failure count resets.

### Scheduler overload

If the job queue exceeds `maxQueueDepth` pending jobs (default 500, configurable via `BURSTGRID_MAX_QUEUE_DEPTH` or `burstgrid.config.yaml`), new webhooks return `503`. GitHub retries for 72 hours — the event is never dropped, it just waits.

**Peak traffic (1000s of concurrent PRs):** The queue absorbs the burst. The autoscaler detects surplus demand and launches additional hosts (with ~90 s EC2 boot lag). If the queue fills before new hosts come online, GitHub gets `503` and retries. For sustained high throughput, externalizing the queue to Redis (sorted sets) and running multiple scheduler instances behind an ALB is the next milestone — the scheduler's current in-memory state is the bottleneck for horizontal scale.

### Worker disconnects

Workers reconnect automatically with exponential backoff (1s → 2s → 4s … → 30s cap). On reconnect, the worker re-registers so the scheduler's slot accounting stays consistent. Jobs running inside microVMs are unaffected — the VM runs independently of the SSE connection.

### Monitoring

```
GET /health    → { ok: true }                         liveness probe
GET /v1/status → { connectedWorkers, totalFreeSlots, queuedJobs }
```

## Observability

BurstGrid emits OpenTelemetry metrics. The recommended deployment is [OpenTelemetry Collector Contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib) — one collector per worker host, one on the scheduler host.

```
[Scheduler]    --OTLP--> [Collector on scheduler host] --┐
[Worker agent] --OTLP--> [Collector on worker host]    --┼--> Grafana / Datadog / Prometheus
[Firecracker VMs]  (via network TAP → host collector)  --┘
```

**Quick start:**

```bash
# 1. Download the collector binary
curl -L https://github.com/open-telemetry/opentelemetry-collector-releases/releases/latest/download/otelcol-contrib_linux_amd64.tar.gz | tar xz

# 2. Copy the example config
cp deploy/otel-collector/collector.yaml /etc/otelcol-contrib/config.yaml

# 3. Set your backend credentials and point BurstGrid at the collector
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export GRAFANA_OTLP_ENDPOINT=https://otlp-gateway-prod-us-east-0.grafana.net/otlp
export GRAFANA_INSTANCE_ID=123456
export GRAFANA_API_KEY=glc_...

# 4. Start collector, then BurstGrid
./otelcol-contrib --config /etc/otelcol-contrib/config.yaml &
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm dev:scheduler
```

See [`deploy/otel-collector/collector.yaml`](deploy/otel-collector/collector.yaml) for the full annotated config including Datadog and self-hosted Prometheus exporters.

**Telemetry from inside microVMs:** Processes inside a Firecracker VM can reach the host collector via the TAP interface gateway IP (typically `172.16.0.1`). Configure the GitHub Actions runner image with `OTEL_EXPORTER_OTLP_ENDPOINT=http://172.16.0.1:4318`. The vsock device is also provisioned on each VM (guest CID 3) for direct host communication without the network stack.

| Metric | Type | Description |
|---|---|---|
| `burstgrid.queue.depth` | Gauge | Current queued job count |
| `burstgrid.workers.connected` | Gauge | Workers with active SSE connections |
| `burstgrid.workers.free_slots` | Gauge | Total free microVM slots across all workers |
| `burstgrid.jobs.queued` | Counter | Jobs received from GitHub webhooks |
| `burstgrid.jobs.dispatched` | Counter | Jobs dispatched to workers |
| `burstgrid.job.dispatch_latency_ms` | Histogram | Time from webhook receipt to dispatch |
| `burstgrid.vm.boot_duration_ms` | Histogram | Firecracker microVM boot time |
| `burstgrid.job.duration_ms` | Histogram | Total job execution time inside the VM |

## Architecture notes

- **SSE over long-poll**: One persistent connection per worker. The scheduler pushes job assignments as `data:` events. Workers send heartbeats and status updates via separate POST requests. No message broker, no gRPC codegen required.
- **No Kubernetes**: ARC (Actions Runner Controller) delegates scaling to Kubernetes, which adds operational complexity without solving the underlying problem — AWS supply constraints exist at the EC2 API level, not the pod-scheduler level. BurstGrid owns the loop directly: tier routing, circuit breaking, and back-pressure are first-class, not bolted on via k8s annotations. ARC also gives container-level isolation; BurstGrid gives VM-level isolation (separate kernel per job, destroyed after completion).
- **State storage**: The scheduler holds worker registry and job queue in memory. When you're ready for HA, Redis (ElastiCache) is the right target: sorted sets map directly to the priority queue, TTL handles heartbeat expiry, and pub/sub could eventually replace SSE. S3 is wrong for this — it's a blob store with ~10–50ms per-object latency. Use S3 for job artifacts, logs, and storing the VM image and kernel distribution. Use DynamoDB Streams or SQS if you want event-driven job history without running Redis.
- **Graceful scale-down**: Workers drain naturally — no mid-job termination. The autoscaler notes surplus capacity but lets idle workers exit.
- **Job sizing**: Add a `burstgrid:size=large` (or `xlarge`, `medium`, `small`) label to a workflow's `runs-on` list to control microVM resources. Default is 2 vCPU / 2 GiB. `xlarge` gives 8 vCPU / 8 GiB.
