output "scheduler_url" {
  value = module.scheduler.scheduler_url
}

output "launch_template_ids" {
  value = module.worker_fleet.launch_template_ids
}

output "spot_queue_url" {
  value = module.worker_fleet.spot_queue_url
}
