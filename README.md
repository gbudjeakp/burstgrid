# BurstGrid

> **Beta — experimental.** Core APIs are stable; schema may change between minor versions.

Self-hosted GitHub Actions runners on Firecracker microVMs. A TypeScript scheduler receives `workflow_job` webhooks, dispatches jobs to EC2 bare-metal hosts over SSE, and each job boots into a dedicated microVM in under 200 ms — isolated kernel, isolated disk, destroyed on exit.

**Good fit:** 20+ concurrent jobs, strict isolation (SOC 2/HIPAA), or mixed CPU + GPU pipelines.
**Not a fit:** <50 jobs/day, already on Kubernetes (use [ARC](https://github.com/actions/actions-runner-controller)), or highly variable load.

→ **[Full docs](https://gbudjeakp.github.io/burstgrid/)** — setup guide, env var reference, production deploy, HA, spot handling, observability.

## Quick start

```bash
# Docker (scheduler + simulated worker)
docker compose -f docker-compose.dev.yml up
node --import tsx/esm scripts/inject-job.ts --count 3
```

Without Docker:

```bash
pnpm install
NODE_ENV=development BURSTGRID_WEBHOOK_SECRET="" GITHUB_TOKEN=dev \
  node --import tsx/esm bin/scheduler.ts                      # terminal 1
BURSTGRID_MODE=simulate node --import tsx/esm bin/worker-agent.ts  # terminal 2
node --import tsx/esm scripts/inject-job.ts --count 5 --size large # terminal 3
```

Forward real webhooks locally: `gh webhook forward --repo=owner/repo --events=workflow_job --url=http://localhost:8080/webhook/github`

### Local AWS dev environment

```bash
make dev-aws   # or: pnpm dev:aws
```

One command: starts [Floci](https://github.com/floci-io/floci) (a local AWS emulator), seeds the same EC2/IAM/SSM/S3/SQS/DynamoDB resources Terraform creates in production, then runs the scheduler and worker agent with hot reload (`tsx watch` — edit code, see it restart automatically). Lets you confirm AWS-touching changes (autoscaling, SSM secrets, the S3 cache) actually work before paying for real AWS. `make dev-aws-stop` tears it down.

## Workflows

```yaml
jobs:
  test:
    runs-on: [self-hosted, linux, burstgrid:size=large]
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test
```

Size via `burstgrid:size=` (small → 8xlarge) and memory tier via `burstgrid:family=compute|general|memory` — see the [docs](https://gbudjeakp.github.io/burstgrid/#config-shape-matrix) for the full table.

## Configuration

Config lives in `burstgrid.config.yaml` (or `BURSTGRID_CONFIG=/path/to/config.yaml`) — camelCase keys, every one also settable via env var. Full required/optional reference: [docs site](https://gbudjeakp.github.io/burstgrid/#configuration).

Run `npx burstgrid doctor` before a real test or production rollout — it checks local config and prints exact overrides for safer defaults.

## Production deploy

```bash
npx burstgrid setup      # detect VPC/AMI, generate secrets in SSM, write terraform.tfvars
npx burstgrid bake-ami   # optional — pre-installs Firecracker/runner/rootfs for faster worker boot
npx burstgrid deploy     # build, upload to S3, terraform apply
npx burstgrid init       # write launch template IDs into burstgrid.config.yaml
```

Then register a GitHub App (or PAT) webhook at `https://your-scheduler/webhook/github` for `workflow_job` events, and point workflows at `runs-on: [self-hosted, burstgrid:size=large]`.

See the docs for [Terraform variables](https://gbudjeakp.github.io/burstgrid/#configuration), [scheduler HA](https://gbudjeakp.github.io/burstgrid/#config-scheduler-ha), [spot interruption handling](https://gbudjeakp.github.io/burstgrid/#config-spot), and [metrics/alerts](https://gbudjeakp.github.io/burstgrid/#config-scheduler-down) — or [`deploy/terraform/`](deploy/terraform/) and [`deploy/grafana/alerts.yaml`](deploy/grafana/alerts.yaml) directly.

## Build & test

```bash
pnpm install
pnpm build       # dist/
pnpm typecheck
pnpm test
pnpm lint        # oxlint
```
