# Standalone root config: exercises the same modules/scheduler and modules/worker-fleet
# code production uses, against Floci instead of real AWS. Skips the fck-nat NAT module
# and custom private-subnet wiring from the production root — not needed for local module
# testing, and not BurstGrid-authored code to validate here.
#
# Usage:
#   make dev-aws                      # start + seed Floci (also done by the root dev-aws.ts,
#                                      # but this dir is self-contained and works standalone)
#   cd deploy/terraform/floci
#   terraform init
#   terraform apply

# Floci auto-seeds a default VPC + subnets per region on first use.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

locals {
  subnet_id  = data.aws_subnets.default.ids[0]
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "burstgrid-floci-artifacts"
}

module "worker_fleet" {
  source = "../modules/worker-fleet"

  vpc_id        = data.aws_vpc.default.id
  subnet_ids    = local.subnet_id != "" ? [local.subnet_id] : []
  ami           = "ami-alpine" # smallest image in Floci's AMI catalog — fast to pull
  scheduler_url = "http://localhost:8080"
  fleets = [
    { name = "default", instance_type = "t3.micro", slots_per_worker = 1, max_workers = 1, capacity_type = "on-demand" },
  ]
  worker_token               = "floci-dev-worker-token"
  secret_source              = "terraform"
  worker_token_ssm_parameter = "/burstgrid/worker-token"
  otel_collector_enabled     = false
  otel_collector_version     = "latest"
  otel_env_ssm_parameter     = "/burstgrid/otel-collector-env"
  s3_artifacts_bucket        = aws_s3_bucket.artifacts.bucket
  aws_region                 = "us-east-1"
  tags                       = { Environment = "floci-dev" }
}

locals {
  fleets_for_scheduler = [
    {
      name                  = "default"
      sizeTag               = "burstgrid:size=default"
      launchTemplateId      = module.worker_fleet.launch_template_ids["default"]
      subnetIds             = local.subnet_ids
      maxWorkers            = 1
      slotsPerWorker        = 1
      scaleUpThreshold      = 1
      capacityType          = "on-demand"
      scaleDownAfterIdleSec = 300
      minIdleWorkers        = 0
    },
  ]
}

module "scheduler" {
  source = "../modules/scheduler"

  vpc_id        = data.aws_vpc.default.id
  subnet_id     = local.subnet_id
  ami           = "ami-alpine"
  instance_type = "t3.micro"

  webhook_secret               = "floci-dev-webhook-secret"
  worker_token                 = "floci-dev-worker-token"
  github_token                 = "floci-dev-placeholder-token"
  secret_source                = "terraform"
  webhook_secret_ssm_parameter = "/burstgrid/webhook-secret"
  worker_token_ssm_parameter   = "/burstgrid/worker-token"
  github_token_ssm_parameter   = "/burstgrid/github-token"
  github_app_key_ssm_parameter = "/burstgrid/github-app-private-key"
  otel_collector_enabled       = false
  otel_collector_version       = "latest"
  otel_env_ssm_parameter       = "/burstgrid/otel-collector-env"
  burstgrid_fleets             = jsonencode(local.fleets_for_scheduler)
  s3_artifacts_bucket          = aws_s3_bucket.artifacts.bucket
  spot_queue_url               = module.worker_fleet.spot_queue_url
  worker_iam_role_arn          = module.worker_fleet.worker_role_arn
  aws_region                   = "us-east-1"
  tags                         = { Environment = "floci-dev" }
}
