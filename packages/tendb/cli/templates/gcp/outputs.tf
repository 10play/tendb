# `tendb up` folds this straight into tendb.json.
output "cli_discovery" {
  value = jsonencode({
    platform    = "gcp"
    paramPrefix = module.engine.param_prefix
    gcpProject  = var.project
  })
}

output "engine_instance_path" {
  value = module.engine.instance_path
}

output "engine_private_ip" {
  value = module.engine.private_ip
}

output "client_iam_snippet" {
  description = "Grant CI/operator principals tunnel + discovery access."
  value       = module.engine.client_iam_snippet
}
