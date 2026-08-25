.PHONY: build dev-scheduler dev-agent typecheck test install

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

infra-init:
	cd deploy/terraform && terraform init

infra-plan:
	cd deploy/terraform && terraform plan

infra-apply:
	cd deploy/terraform && terraform apply
