# BurstGrid

> **Beta — experimental.** Core APIs are stable; schema may change between minor versions.

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

Config lives in `burstgrid.config.yaml` (or `BURSTGRID_CONFIG=/path/to/config.yaml`). All keys are **camelCase** — the schema is Zod-validated at startup. Every YAML key can also be set via environment variable — no config file required.

| Env var | What it does |
|---|---|
| `BURSTGRID_REDIS_URL` | Redis queue backend (default: in-memory) |
| `BURSTGRID_SQS_QUEUE_URL` + `BURSTGRID_SQS_REGION` | SQS queue backend — durable, no Redis needed |
| `BURSTGRID_DYNAMODB_TABLE` + `BURSTGRID_DYNAMODB_REGION` | DynamoDB job deduplication — drops duplicate webhook deliveries, survives restarts |
| `BURSTGRID_S3_CACHE_BUCKET` + `BURSTGRID_S3_CACHE_REGION` | Serve GitHub Actions cache protocol over S3 — `actions/cache` works with no workflow changes |
| `BURSTGRID_REPO_CONCURRENCY` | Default per-repo concurrency cap (int) |
| `BURSTGRID_SNAPSHOT_POOL_SIZE` | Pre-boot N Firecracker VMs per worker for sub-millisecond first dispatch |

### Per-repo concurrency limits

Prevent any one repo from consuming all runners:

```yaml
scheduler:
  defaultRepoConcurrency: 10    # fallback for any repo not listed below
  concurrencyLimits:
    myorg/*: 20                 # org-wide cap (all repos in myorg)
    myorg/monorepo: 5           # repo-specific cap (takes priority over org wildcard)
```

Or via env var: `BURSTGRID_REPO_CONCURRENCY=10` (sets `defaultRepoConcurrency`).

Jobs over the limit stay queued and are dispatched as running jobs complete — the autoscaler still scales up workers for them normally.

## Production setup

Workers run on stock Ubuntu 24.04 — no custom AMI required. They pull the agent binary from S3 at boot, install the Actions runner, and connect to the scheduler automatically.

### 1. Configure Terraform

Fill in `deploy/terraform/terraform.tfvars`:

```hcl
aws_region          = "us-east-1"
vpc_id              = "vpc-xxxxxxxx"
scheduler_subnet_id = "subnet-xxxxxxxx"   # public subnet (receives GitHub webhooks)
nat_subnet_id       = "subnet-xxxxxxxx"
scheduler_ami       = "ami-xxxxxxxx"       # stock Ubuntu 24.04 ARM64
worker_ami          = "ami-xxxxxxxx"       # same — no custom image needed
s3_artifacts_bucket = "my-burstgrid-bucket"
webhook_secret      = "your-webhook-secret"
worker_token        = "your-worker-token"
```

### 2. Deploy — one command

```bash
npx burstgrid deploy
# builds dist/, uploads scheduler.mjs + worker-agent.mjs to S3, runs terraform apply

# options
npx burstgrid deploy --bucket my-bucket          # explicit bucket (skips tfvars detection)
npx burstgrid deploy --no-terraform --dry-run    # preview without changing anything
```

### 3. Register the GitHub App (or PAT)

Create a GitHub App with **Administration: read & write** + **Actions: read** permissions, subscribe to `workflow_job` events, and set the webhook URL to `https://your-scheduler:8080/webhook/github`.
For single-repo testing a PAT (`GITHUB_TOKEN=ghp_xxx`) is fine.

### 4. Point workflows

```yaml
jobs:
  test:
    runs-on: [self-hosted, linux, burstgrid:size=large]
```

That's the only change needed in your workflow files.

### Scale-down

Idle workers terminate automatically after 300 s. One warm standby is kept per fleet to eliminate cold-start latency. Set `scaleDownAfterIdleSec: 0` to disable.

See [`deploy/terraform/`](deploy/terraform/) for the full AWS module and [`deploy/otel-collector/`](deploy/otel-collector/) for metrics.

## Build & test

```bash
pnpm install
pnpm build       # dist/
pnpm typecheck
pnpm test        # 218 tests
pnpm lint        # oxlint
```
