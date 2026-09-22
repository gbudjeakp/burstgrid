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
  description = "Worker instance AMI. Recommended: output of `npx burstgrid bake-ami` (Firecracker + runner + vmlinux + rootfs pre-installed — workers boot ready, no S3 download). A stock Ubuntu 24.04 ARM64 AMI also works; userdata.sh.tpl falls back to downloading those artifacts from S3 at boot."
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
    name                  = string              # e.g. "medium" — must be unique
    instance_type         = string              # e.g. "m6g.large"
    slots_per_worker      = number              # concurrent jobs per host
    max_workers           = number              # autoscaler ceiling
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
# Provide EITHER github_token (PAT with repo scope) OR github_app_id + a private
# key.  In the default SSM mode these are read by the scheduler at boot, never
# rendered into Terraform state or EC2 user data.

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
  description = "HMAC secret for GitHub webhook payload verification (required only when secret_source=terraform)"
  type        = string
  sensitive   = true
  nullable    = true
  default     = null
}

variable "worker_token" {
  description = "Shared secret workers present on /v1/workers/* routes (required only when secret_source=terraform)"
  type        = string
  sensitive   = true
  nullable    = true
  default     = null
}

variable "secret_source" {
  description = "Secret delivery mode: ssm (default, fetched by EC2 at boot) or terraform (legacy values rendered into user data)."
  type        = string
  default     = "ssm"

  validation {
    condition     = contains(["ssm", "terraform"], var.secret_source)
    error_message = "secret_source must be either ssm or terraform."
  }
}

variable "ssm_parameter_prefix" {
  description = "Prefix containing pre-created SecureString parameters: webhook-secret, worker-token, github-token, and github-app-private-key."
  type        = string
  default     = "/burstgrid"

  validation {
    condition     = startswith(var.ssm_parameter_prefix, "/") && !endswith(var.ssm_parameter_prefix, "/")
    error_message = "ssm_parameter_prefix must start with / and not end with /."
  }
}

variable "otel_collector_enabled" {
  description = "Start the bundled OpenTelemetry Collector on scheduler and workers. Requires the otel-collector-env SecureString under ssm_parameter_prefix."
  type        = bool
  default     = false
}

variable "otel_collector_version" {
  description = "OpenTelemetry Collector Contrib version to install on non-baked hosts."
  type        = string
  default     = "0.116.0"
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
