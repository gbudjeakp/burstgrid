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

Config lives in `burstgrid.config.yaml` (or `BURSTGRID_CONFIG=/path/to/config.yaml`). All keys are **camelCase** — the schema is Zod-validated at startup.

## Production setup

### 1. Create EC2 launch templates

BurstGrid looks for launch templates named `burstgrid-<size>` (e.g. `burstgrid-large`). Each template must:
- Use a BurstGrid worker AMI (with `burstgrid-worker-agent` installed and enabled as a systemd service)
- Include an IAM instance profile with EC2 describe + SSM permissions
- Have a security group with outbound HTTPS (443) to GitHub and your scheduler

```bash
aws ec2 create-launch-template \
  --launch-template-name burstgrid-large \
  --launch-template-data '{
    "ImageId": "ami-XXXX",
    "InstanceType": "m6g.2xlarge",
    "IamInstanceProfile": {"Name": "burstgrid-worker"},
    "SecurityGroupIds": ["sg-XXXX"],
    "UserData": "<base64-encoded user-data>"
  }'
```

Workers must be **bare-metal or standard EC2** — Firecracker requires KVM (`m6g.metal`, `m7i.metal-*`, or any `.metal` type). Use standard instances (e.g. `m6g.2xlarge`) for `process` mode only.

### 2. Generate config from AWS

Once templates exist, `burstgrid init` auto-discovers them and your VPC subnets:

```bash
npx burstgrid init                   # writes burstgrid.config.yaml in the current directory
npx burstgrid init --region us-west-2
npx burstgrid init --out /etc/burstgrid/config.yaml
```

This queries your AWS account for:
- All launch templates matching `burstgrid-*`
- The VPC with the most AZ coverage, picks one subnet per AZ

If no templates are found, the command prints the exact `aws ec2 create-launch-template` command needed and writes a config with placeholders.

### 3. Deploy the scheduler

```bash
# Build
pnpm build

# Upload scheduler binary to S3
aws s3 cp dist/scheduler.mjs s3://your-bucket/scheduler.mjs

# Start on your scheduler EC2 instance
BURSTGRID_GITHUB_TOKEN=ghp_xxx \
BURSTGRID_WEBHOOK_SECRET=your-secret \
BURSTGRID_CONFIG=/etc/burstgrid/config.yaml \
node dist/scheduler.mjs
```

### 4. Register GitHub webhook

Point your repo (or org) webhook at `https://scheduler-host:8080/webhook/github`, content type `application/json`, events: **Workflow jobs**.

### 5. Scale-down

Idle workers terminate automatically after `scaleDownAfterIdleSec` (default 300 s). One warm standby is kept per fleet to avoid cold-start latency on the next burst. Set `scaleDownAfterIdleSec: 0` to disable.

See [`deploy/terraform/`](deploy/terraform/) for full AWS infra and [`deploy/otel-collector/`](deploy/otel-collector/) for metrics.

## Build & test

```bash
pnpm install
pnpm build       # dist/
pnpm typecheck
pnpm test        # 184 tests
pnpm lint        # oxlint
```
