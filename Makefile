.PHONY: build dev-scheduler dev-agent typecheck test install demo demo-stop dev-aws dev-aws-stop

install:
	pnpm install

build:
	pnpm run build

dev-scheduler:
	pnpm run dev:scheduler

dev-agent:
	pnpm run dev:agent

typecheck:
	pnpm run typecheck

test:
	pnpm test

# One command: local AWS emulator (Floci) seeded with EC2/IAM/SSM/S3/SQS/DynamoDB/ALB/CloudTrail,
# plus the scheduler and worker agent running as hot-reloaded local processes (tsx watch) —
# edit source, see it reload, no rebuild/restart needed. Ctrl+C stops the Node processes;
# Floci itself keeps running (`make dev-aws-stop` to tear it down).
dev-aws:
	pnpm run dev:aws

dev-aws-stop:
	pnpm run dev:aws:down

# Run the full simulate-mode stack locally — no AWS, no KVM, no Firecracker needed.
demo:
	@command -v docker > /dev/null 2>&1 || { echo "docker is required"; exit 1; }
	@[ -d node_modules ] || pnpm install
	@echo "→ Starting BurstGrid (simulate mode)..."
	docker compose -f docker-compose.dev.yml up -d --build
	@echo "→ Waiting for scheduler to be ready..."
	@for i in $$(seq 1 60); do \
	  curl -sf http://localhost:8080/health/ready > /dev/null 2>&1 && echo " ready" && break; \
	  printf '.'; sleep 1; \
	done
	@echo "→ Injecting 5 test jobs (3 large, 2 xlarge)..."
	node --import tsx/esm scripts/inject-job.ts --count 3 --size large
	node --import tsx/esm scripts/inject-job.ts --count 2 --size xlarge
	@echo ""
	@echo "→ Tailing logs — Ctrl+C stops tailing, stack keeps running"
	@echo "   Run 'make demo-stop' to tear everything down"
	docker compose -f docker-compose.dev.yml logs --tail=50 -f scheduler worker

demo-stop:
	docker compose -f docker-compose.dev.yml down --volumes

infra-init:
	cd deploy/terraform && terraform init

infra-plan:
	cd deploy/terraform && terraform plan

infra-apply:
	cd deploy/terraform && terraform apply
