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
  description = "Public subnet for the scheduler (needs GitHub webhook access)"
  type        = string
}

variable "worker_subnet_ids" {
  description = "Subnets for worker instances — use multiple AZs for capacity diversification"
  type        = list(string)
}

variable "scheduler_ami" {
  description = "AMI for the scheduler (Amazon Linux 2023 recommended)"
  type        = string
}

variable "worker_ami" {
  description = "Custom AMI for worker hosts with Firecracker + runner rootfs pre-installed"
  type        = string
}

variable "scheduler_instance_type" {
  description = "Scheduler instance type — the scheduler is mostly I/O bound"
  type        = string
  default     = "t3.small"
}

variable "worker_instance_type" {
  description = "Worker instance type — size determines how many microVM slots fit"
  type        = string
  default     = "c7i.4xlarge"
}

variable "slots_per_worker" {
  description = "Number of concurrent Firecracker microVM slots per worker host"
  type        = number
  default     = 16
}

variable "github_webhook_secret" {
  description = "HMAC secret for GitHub webhook signature verification"
  type        = string
  sensitive   = true
}

variable "github_app_id" {
  description = "GitHub App ID for runner token creation"
  type        = number
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
