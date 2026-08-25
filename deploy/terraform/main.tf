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

module "scheduler" {
  source = "./modules/scheduler"

  vpc_id              = var.vpc_id
  subnet_id           = var.scheduler_subnet_id
  ami                 = var.scheduler_ami
  instance_type       = var.scheduler_instance_type
  webhook_secret      = var.github_webhook_secret
  github_app_id       = var.github_app_id
  worker_iam_role_arn = module.worker_fleet.worker_role_arn
  tags                = var.tags
}

module "worker_fleet" {
  source = "./modules/worker-fleet"

  vpc_id             = var.vpc_id
  subnet_ids         = var.worker_subnet_ids
  scheduler_endpoint = module.scheduler.internal_endpoint
  ami                = var.worker_ami
  instance_type      = var.worker_instance_type
  slots_per_worker   = var.slots_per_worker
  tags               = var.tags
}
