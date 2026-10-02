output "scheduler_url" {
  description = "Base URL for the scheduler — ALB DNS name when scheduler_ha_enabled=true, the EIP otherwise"
  value       = module.scheduler.scheduler_url
}

output "scheduler_public_ip" {
  description = "Elastic IP of the BurstGrid scheduler — null when scheduler_ha_enabled=true (traffic goes through the ALB instead)"
  value       = module.scheduler.public_ip
}

# Point your GitHub org/repo webhook at this URL, content-type: application/json,
# events: workflow_job, secret: var.github_webhook_secret
output "github_webhook_url" {
  description = "GitHub webhook URL — set events=[workflow_job], content-type=application/json"
  value       = "${module.scheduler.scheduler_url}/webhook/github"
}

output "scheduler_health_url" {
  description = "Health check endpoint"
  value       = "${module.scheduler.scheduler_url}/health"
}

output "launch_template_ids" {
  description = "Map of fleet name → launch template ID"
  value       = module.worker_fleet.launch_template_ids
}

output "spot_queue_url" {
  description = "SQS URL for EC2 spot interruption warnings"
  value       = module.worker_fleet.spot_queue_url
}

output "nat_instance_type" {
  description = "fck-nat instance type (replaces Managed NAT Gateway)"
  value       = module.nat.instance_type
}

output "nat_eni_id" {
  description = "Static ENI used by fck-nat — visible in VPC console"
  value       = module.nat.eni_id
}
