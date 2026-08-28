output "scheduler_public_ip" {
  description = "Elastic IP of the BurstGrid scheduler (stable across instance replacements)"
  value       = module.scheduler.public_ip
}

# Point your GitHub org/repo webhook at this URL, content-type: application/json,
# events: workflow_job, secret: var.github_webhook_secret
output "github_webhook_url" {
  description = "GitHub webhook URL — set events=[workflow_job], content-type=application/json"
  value       = "http://${module.scheduler.public_ip}:8080/webhook"
}

output "scheduler_health_url" {
  description = "Health check endpoint"
  value       = "http://${module.scheduler.public_ip}:8080/health"
}

output "launch_template_ids" {
  description = "Map of fleet name → launch template ID"
  value       = module.worker_fleet.launch_template_ids
}

output "spot_queue_url" {
  description = "SQS URL for EC2 spot interruption warnings"
  value       = module.worker_fleet.spot_queue_url
}
