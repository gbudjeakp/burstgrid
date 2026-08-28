# BurstGrid

> **Alpha — not production-ready.** APIs and config schema will change without notice.

Self-hosted GitHub Actions runners on Firecracker microVMs. A TypeScript scheduler receives `workflow_job` webhooks, dispatches jobs to EC2 bare-metal hosts over SSE, and each job boots into a dedicated microVM in under 200 ms — isolated kernel, isolated disk, destroyed on exit.

**Good fit:** 20+ concurrent jobs, strict isolation (SOC 2/HIPAA), or mixed CPU + GPU pipelines.  
**Not a fit:** <50 jobs/day, already on Kubernetes (use [ARC](https://github.com/actions/actions-runner-controller)), or highly variable load.

→ [Full docs](https://gbudjeakp.github.io/burstgrid/)

## Quick start

```bash
# Docker (scheduler + simulated worker)
docker compose -f docker-compose.dev.yml up

# Inject test jobs
node --import tsx/esm scripts/inject-job.ts --count 3
```

Without Docker:

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

| Label | vCPU | Memory |
|---|---|---|
| `small` | 1 | 1 GiB |
| `medium` _(default)_ | 2 | 2 GiB |
| `large` | 4 | 4 GiB |
| `xlarge` | 8 | 8 GiB |
| `2xlarge` | 16 | 32 GiB |
| `4xlarge` | 32 | 64 GiB |
| `8xlarge` | 64 | 128 GiB |

## Worker modes

| `BURSTGRID_MODE` | What happens |
|---|---|
| `firecracker` _(default)_ | Boots a Firecracker microVM per job |
| `process` | Spawns the runner directly — for GPU hosts (no PCIe passthrough in Firecracker) |
| `simulate` | 2 s no-op — local dev and testing, no KVM needed |

## Workflows

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

## Configuration

Config lives in `burstgrid.config.yaml` (or `BURSTGRID_CONFIG=/path/to/config.yaml`). All keys are **camelCase** — the schema is Zod-validated at startup. See the [setup guide](https://gbudjeakp.github.io/burstgrid/#get-started) for env vars and the full YAML reference.

## Production

Workers must be **bare-metal EC2** (`m7i.metal-*`, `m6g.metal`, etc.) — Firecracker requires KVM. The scheduler runs on any standard instance (`t3.small` is fine).

See [`deploy/terraform/`](deploy/terraform/) for AWS infra and [`deploy/otel-collector/`](deploy/otel-collector/) for metrics.

```bash
make infra-init && make infra-plan && make infra-apply
```

## Build & test

```bash
pnpm install
pnpm build       # dist/
pnpm typecheck
pnpm test        # 134 tests
pnpm lint        # oxlint
```
