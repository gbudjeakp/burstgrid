# BurstGrid

> **⚠️ Highly experimental — do not use in production.**
> This is a research-grade project. The scheduler, worker agent, and Firecracker integration are functional, but nothing has been tested end-to-end on real AWS infrastructure. APIs, config schema, and wire formats will change without notice. Security has not been audited. If you run this in production and something breaks, that is expected.

Self-hosted GitHub Actions runners on Firecracker microVMs. A TypeScript scheduler receives `workflow_job` webhooks, dispatches jobs to EC2 bare-metal hosts over SSE, and each job boots into a dedicated microVM in under 200 ms — then disappears.

**Good fit:** teams running 20+ concurrent CI jobs with consistent load, strict isolation requirements (SOC 2, HIPAA), or mixed CPU + GPU pipelines.
**Not a good fit:** &lt;50 jobs/day, orgs already on Kubernetes (use [ARC](https://github.com/actions/actions-runner-controller)), or highly variable/spiky load. [See the full fit guide →](https://gbudjeakp.github.io/burstgrid/#who-its-for)

```
GitHub webhook
      │
      ▼
┌──────────────────┐   SSE push (persistent)   ┌──────────────────────────────────────┐
│    Scheduler     │ ─────────────────────────► │  Worker Host (EC2 bare metal)        │
│                  │ ◄─────────────────────────  │                                      │
│  job queue       │   heartbeat / status POST  │  slot 0 → Firecracker VM → job       │
│  worker registry │                             │  slot 1 → Firecracker VM → job       │
│  circuit breaker │                             │  ...up to N slots                    │
│  autoscaler      │                             └──────────────────────────────────────┘
└──────────────────┘
```

## Quick start

### Docker (recommended for local dev)

```bash
docker compose -f docker-compose.dev.yml up
```

Starts a scheduler + simulate worker + Docker registry mirror. Inject test jobs:

```bash
node --import tsx/esm scripts/inject-job.ts --count 3
node --import tsx/esm scripts/inject-job.ts --size 2xlarge --gpu --count 2
```

### No Docker

```bash
pnpm install

# Terminal 1 — scheduler
NODE_ENV=development BURSTGRID_WEBHOOK_SECRET="" GITHUB_TOKEN=dev \
  node --import tsx/esm bin/scheduler.ts

# Terminal 2 — simulate worker (no Firecracker needed)
BURSTGRID_MODE=simulate node --import tsx/esm bin/worker-agent.ts

# Terminal 3 — inject test jobs
node --import tsx/esm scripts/inject-job.ts --count 5 --size large
```

Forward real webhooks locally:

```bash
gh webhook forward --repo=owner/repo --events=workflow_job --url=http://localhost:8080/webhook/github
```

## VM sizes

Set via `runs-on` label: `burstgrid:size=2xlarge`

| Label | vCPU | Memory | Use case |
|---|---|---|---|
| `small` | 1 | 1 GiB | Scripts, linting |
| `medium` _(default)_ | 2 | 2 GiB | Standard builds |
| `large` | 4 | 4 GiB | Integration tests |
| `xlarge` | 8 | 8 GiB | Heavy builds |
| `2xlarge` | 16 | 32 GiB | ML / large monorepos |
| `4xlarge` | 32 | 64 GiB | Distributed workloads |
| `8xlarge` | 64 | 128 GiB | Very large workloads |

## Worker modes

| `BURSTGRID_MODE` | What happens | When to use |
|---|---|---|
| `firecracker` _(default)_ | Boots a Firecracker microVM per job | Production |
| `process` | Spawns `BURSTGRID_RUNNER_PATH` directly (no VM) | GPU hosts — Firecracker has no PCIe passthrough |
| `simulate` | 2 s no-op — no VM or runner | Local dev and testing |

**GPU routing:** register GPU workers with `BURSTGRID_CAPABILITIES=linux,x86_64,docker,gpu` and `BURSTGRID_MODE=process`. Jobs with `gpu` in their `runs-on` labels route exclusively to those workers.

## Registry cache

Set `BURSTGRID_REGISTRY_MIRROR=http://<host>:5000` on workers. The URL is injected as a kernel boot arg; the rootfs init writes `/etc/docker/daemon.json` before Docker starts. Layers are cached on the host and served to all subsequent VMs.

**Rootfs init snippet:**
```bash
MIRROR=$(grep -oP 'REGISTRY_MIRROR=\K\S+' /proc/cmdline || true)
[ -n "$MIRROR" ] && echo "{\"registry-mirrors\":[\"$MIRROR\"]}" > /etc/docker/daemon.json
```

On AWS: use an **ECR pull-through cache** endpoint — same config, no extra infra.

## Configuration

### Scheduler

| Variable | Default | Description |
|---|---|---|
| `BURSTGRID_ADDR` | `0.0.0.0` | Listen address |
| `BURSTGRID_PORT` | `8080` | Listen port |
| `BURSTGRID_WEBHOOK_SECRET` | — | GitHub webhook HMAC secret |
| `BURSTGRID_WORKER_TOKEN` | — | Shared secret workers must send as `Authorization: Bearer` |
| `BURSTGRID_MAX_QUEUE_DEPTH` | `500` | Jobs before returning 503 |
| `GITHUB_APP_ID` | — | GitHub App numeric ID |
| `GITHUB_PRIVATE_KEY_PATH` | — | Path to App private key PEM file |
| `GITHUB_PRIVATE_KEY` | — | PEM content as env var (alternative to file; use for Secrets Manager) |
| `GITHUB_TOKEN` | — | PAT for dev (overrides App auth) |
| `BURSTGRID_CONFIG` | `./burstgrid.config.yaml` | YAML config path |

### Worker agent

| Variable | Default | Description |
|---|---|---|
| `BURSTGRID_SCHEDULER_URL` | `http://localhost:8080` | Scheduler address |
| `BURSTGRID_WORKER_ID` | EC2 instance-id or hostname | Auto-detected from IMDS; set explicitly to override |
| `BURSTGRID_SLOTS` | `floor(cpuCount / 2)` | Max concurrent VM slots; auto-calculated if unset |
| `BURSTGRID_VCPUS` | `os.cpus().length` | Total host vCPUs; auto-detected if unset |
| `BURSTGRID_MEMORY_MIB` | `os.totalmem()` | Total host memory in MiB; auto-detected if unset |
| `BURSTGRID_CAPABILITIES` | `linux,<arch>[,docker][,gpu,cuda]` | Auto-detected: arch + Docker + nvidia-smi presence |
| `BURSTGRID_MODE` | `firecracker` | `firecracker` / `process` / `simulate` |
| `BURSTGRID_VM_IMAGE` | `/var/lib/burstgrid/runner.img` | Firecracker rootfs path |
| `BURSTGRID_KERNEL` | `/var/lib/burstgrid/vmlinux` | Firecracker kernel path |
| `BURSTGRID_WORKER_TOKEN` | — | Shared secret matching scheduler's token |
| `BURSTGRID_REGISTRY_MIRROR` | — | Docker pull-through mirror URL |
| `BURSTGRID_IMAGE_DIR` | — | Directory of pre-baked rootfs images (`burstgrid:image=<name>`) |
| `BURSTGRID_RUNNER_PATH` | `./run.sh` | Runner script path (`process` mode) |

Full multi-fleet autoscaler config: [`burstgrid.config.yaml`](burstgrid.config.yaml).

## Production

See [`deploy/terraform/`](deploy/terraform/) for AWS infrastructure.

**Instance requirements:** Firecracker requires KVM. **Worker instances must be bare metal** — `m7i.metal-*`, `m6g.metal`, `m7g.metal`, etc. The scheduler runs on any standard instance (`t3.small` is fine).

```bash
make infra-init && make infra-plan && make infra-apply
```

### GitHub App setup

1. Settings → Developer Settings → GitHub Apps → New GitHub App
2. Webhook URL: `https://your-scheduler/webhook/github`, generate a secret
3. Permissions: `Administration: read+write`, `Actions: read`; subscribe to `workflow_job`
4. Generate and download the private key PEM
5. Install the App on your org

### Using BurstGrid in a workflow

```yaml
jobs:
  test:
    runs-on: [self-hosted, linux, burstgrid:size=large]
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test

  ml-job:
    runs-on: [self-hosted, linux, gpu, burstgrid:size=4xlarge]
    steps:
      - run: python train.py
```

## Building & testing

```bash
pnpm install
pnpm build       # outputs to dist/
pnpm typecheck
pnpm test        # 46 tests
pnpm lint        # oxlint
```

## Health & observability

```
GET /health     → { ok: true }
GET /v1/status  → { connectedWorkers, totalFreeSlots, queuedJobs }
```

OTel metrics: queue depth, dispatch latency, VM boot time, job duration. See [`deploy/otel-collector/`](deploy/otel-collector/).
