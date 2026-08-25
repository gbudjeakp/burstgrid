output "scheduler_public_ip" {
  description = "Public IP of the BurstGrid scheduler"
  value       = module.scheduler.public_ip
}

output "github_webhook_url" {
  description = "Configure this as your GitHub organization webhook URL"
  value       = "http://${module.scheduler.public_ip}:8080/webhook/github"
}

output "worker_launch_template_id" {
  description = "Set BURSTGRID_LAUNCH_TEMPLATE_ID on the scheduler to enable autoscaling"
  value       = module.worker_fleet.launch_template_id
}
