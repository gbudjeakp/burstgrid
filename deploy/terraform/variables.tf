# ── Region + network ──────────────────────────────────────────────────────────

variable "aws_region" {
  description = "AWS region for all BurstGrid resources"
  type        = string
  default     = "us-east-1"
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "scheduler_subnet_id" {
  description = "Public subnet for the scheduler (needs inbound access from GitHub webhook IPs)"
  type        = string
}

variable "nat_subnet_id" {
  description = "Public subnet for the fck-nat instance — must have an internet gateway route"
  type        = string
}

variable "nat_instance_type" {
  description = "Instance type for the fck-nat NAT instance. t4g.nano handles up to 5Gbps burst."
  type        = string
  default     = "t4g.nano"
}

# ── AMIs ───────────────────────────────────────────────────────────────────────
# Use Ubuntu 24.04 ARM64 for ARM (m6g/c7g) or AMD64 for x86 fleets.
# Ubuntu AMI finder: https://cloud-images.ubuntu.com/locator/ec2/
# Example ARM64 us-east-1: ami-06f318091abc639be (Ubuntu 24.04, 2026-08-28)

variable "scheduler_ami" {
  description = "Ubuntu 24.04 ARM64 or AMD64 AMI for the scheduler instance"
  type        = string
}

variable "worker_ami" {
  description = "Ubuntu 24.04 ARM64 AMI for worker instances (must match fleet instance families)"
  type        = string
}

# ── Instance types ─────────────────────────────────────────────────────────────

variable "scheduler_instance_type" {
  description = "Scheduler instance type — I/O bound; t4g.small is fine for < 500 concurrent jobs"
  type        = string
  default     = "t4g.small"
}

# ── Fleet definitions ──────────────────────────────────────────────────────────
# Each fleet maps to one launch template and one autoscaler tier.
# sizeTag must match the `burstgrid:size=<name>` runner label in your workflow YAML.

variable "fleets" {
  description = "Worker fleet tiers. Each creates one launch template and one autoscaler tier."
  type = list(object({
    name               = string              # e.g. "medium" — must be unique
    instance_type      = string              # e.g. "m6g.large"
    slots_per_worker   = number              # concurrent jobs per host
    max_workers        = number              # autoscaler ceiling
    scale_up_threshold    = optional(number, 1) # queued jobs before launching a new host
    capacity_type         = optional(string, "spot")
    scale_down_after_idle = optional(number, 300) # seconds idle before termination
    min_idle_workers      = optional(number, 0)   # warm standbys to keep alive
  }))
  default = [
    {
      name               = "default"
      instance_type      = "m6g.large"
      slots_per_worker   = 2
      max_workers        = 10
      scale_up_threshold = 1
    }
  ]
}

# ── GitHub auth ────────────────────────────────────────────────────────────────
# Provide EITHER github_token (PAT with repo scope) OR github_app_id + the SSM
# parameter /burstgrid/github-app-private-key containing the PEM.

variable "github_token" {
  description = "GitHub PAT with repo scope — used to create runner registration tokens"
  type        = string
  sensitive   = true
  default     = ""
}

variable "github_app_id" {
  description = "GitHub App ID (alternative to github_token — requires SSM parameter)"
  type        = number
  default     = 0
}

# ── Secrets ────────────────────────────────────────────────────────────────────

variable "scheduler_url_override" {
  description = "Override the scheduler URL baked into worker launch templates (e.g. if using a stable EIP separate from the Terraform-managed one)"
  type        = string
  default     = ""
}

variable "github_webhook_secret" {
  description = "HMAC secret for GitHub webhook payload verification"
  type        = string
  sensitive   = true
}

variable "worker_token" {
  description = "Shared secret workers present on /v1/workers/* routes"
  type        = string
  sensitive   = true
}

# ── S3 ─────────────────────────────────────────────────────────────────────────

variable "s3_artifacts_bucket" {
  description = "S3 bucket containing scheduler.mjs and worker-agent.mjs artifacts"
  type        = string
}

# ── Tags ───────────────────────────────────────────────────────────────────────

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
