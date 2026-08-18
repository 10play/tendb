output "cli_discovery" {
  description = "Drop into tendb.json at your repo root — the CLI discovers everything else from Secret Manager."
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

output "console_url" {
  value = var.enable_console ? module.console[0].url : null
}

output "console_dns_record" {
  description = "Non-null when the console's DNS is managed elsewhere — create this record."
  value       = var.enable_console ? module.console[0].required_dns_record : null
}
