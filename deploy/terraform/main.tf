terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0" # fck-nat module requires >= 6.0
    }
  }
  required_version = ">= 1.9"
}

provider "aws" {
  region = var.aws_region
}

# ── Private subnets for workers ────────────────────────────────────────────────
# Workers in private subnets get no public IP → saves $0.12/worker/day under
# the 2024 AWS per-IP pricing. fck-nat below provides their internet egress.

locals {
  # One private subnet per AZ — spread for spot capacity diversification.
  worker_private_subnets = {
    "us-east-1a" = "172.31.96.0/20"
    "us-east-1b" = "172.31.112.0/20"
    "us-east-1c" = "172.31.128.0/20"
  }
}

resource "aws_subnet" "worker_private" {
  for_each = local.worker_private_subnets

  vpc_id                  = var.vpc_id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false

  tags = merge(var.tags, { Name = "burstgrid-workers-${each.key}" })
}

resource "aws_route_table" "worker_private" {
  for_each = local.worker_private_subnets

  vpc_id = var.vpc_id
  tags   = merge(var.tags, { Name = "burstgrid-workers-${each.key}" })
}

resource "aws_route_table_association" "worker_private" {
  for_each = local.worker_private_subnets

  subnet_id      = aws_subnet.worker_private[each.key].id
  route_table_id = aws_route_table.worker_private[each.key].id
}

# ── NAT Instance (fck-nat) ────────────────────────────────────────────────────
# Replaces Managed NAT Gateway: ~$1.08/day → ~$0.10/day on a t4g.nano.
# HA mode keeps an ASG so the instance self-recovers on failure.

module "nat" {
  source  = "RaJiska/fck-nat/aws"
  version = "~> 1.6"

  name      = "burstgrid-nat"
  vpc_id    = var.vpc_id
  subnet_id = var.nat_subnet_id

  instance_type      = var.nat_instance_type
  ha_mode            = true
  use_spot_instances = false # NAT interruption would kill in-progress CI jobs

  # Automatically inject 0.0.0.0/0 → fck-nat ENI into each private route table.
  update_route_tables = true
  route_tables_ids = {
    for az, _ in local.worker_private_subnets :
    az => aws_route_table.worker_private[az].id
  }

  tags = var.tags
}

# ── Worker fleet ───────────────────────────────────────────────────────────────
# Must be declared before scheduler so launch template IDs are available.

module "worker_fleet" {
  source = "./modules/worker-fleet"

  vpc_id              = var.vpc_id
  subnet_ids          = [for s in aws_subnet.worker_private : s.id]
  ami                 = var.worker_ami
  scheduler_url       = coalesce(var.scheduler_url_override, "http://${module.scheduler.public_ip}:8080")
  fleets              = var.fleets
  worker_token        = var.worker_token
  s3_artifacts_bucket = var.s3_artifacts_bucket
  aws_region          = var.aws_region
  tags                = var.tags
}

# Build the BURSTGRID_FLEETS JSON that the scheduler reads at startup.
locals {
  fleets_for_scheduler = [
    for f in var.fleets : {
      name                  = f.name
      sizeTag               = "burstgrid:size=${f.name}"
      launchTemplateId      = module.worker_fleet.launch_template_ids[f.name]
      subnetIds             = [for s in aws_subnet.worker_private : s.id]
      maxWorkers            = f.max_workers
      slotsPerWorker        = f.slots_per_worker
      scaleUpThreshold      = coalesce(f.scale_up_threshold, 1)
      capacityType          = coalesce(f.capacity_type, "spot")
      scaleDownAfterIdleSec = coalesce(f.scale_down_after_idle, 300)
      minIdleWorkers        = coalesce(f.min_idle_workers, 0)
    }
  ]
}

# ── Scheduler ──────────────────────────────────────────────────────────────────

module "scheduler" {
  source = "./modules/scheduler"

  vpc_id              = var.vpc_id
  subnet_id           = var.scheduler_subnet_id
  ami                 = var.scheduler_ami
  instance_type       = var.scheduler_instance_type
  webhook_secret      = var.github_webhook_secret
  worker_token        = var.worker_token
  github_token        = var.github_token
  github_app_id       = var.github_app_id
  burstgrid_fleets    = jsonencode(local.fleets_for_scheduler)
  s3_artifacts_bucket = var.s3_artifacts_bucket
  spot_queue_url      = module.worker_fleet.spot_queue_url
  worker_iam_role_arn = module.worker_fleet.worker_role_arn
  aws_region          = var.aws_region
  tags                = var.tags
}
