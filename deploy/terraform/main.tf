terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.5"
}

provider "aws" {
  region = var.aws_region
}

# ── Worker fleet ───────────────────────────────────────────────────────────────
# Must be declared before scheduler so launch template IDs are available.

module "worker_fleet" {
  source = "./modules/worker-fleet"

  vpc_id               = var.vpc_id
  subnet_ids           = var.worker_subnet_ids
  ami                  = var.worker_ami
  fleets               = var.fleets
  worker_token         = var.worker_token
  s3_artifacts_bucket  = var.s3_artifacts_bucket
  aws_region           = var.aws_region
  tags                 = var.tags
}

# Build the BURSTGRID_FLEETS JSON that the scheduler reads at startup.
locals {
  fleets_for_scheduler = [
    for f in var.fleets : {
      name               = f.name
      sizeTag            = "burstgrid:size=${f.name}"
      launchTemplateId   = module.worker_fleet.launch_template_ids[f.name]
      subnetIds          = var.worker_subnet_ids
      maxWorkers         = f.max_workers
      slotsPerWorker     = f.slots_per_worker
      scaleUpThreshold   = coalesce(f.scale_up_threshold, 1)
      capacityType       = coalesce(f.capacity_type, "spot")
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
