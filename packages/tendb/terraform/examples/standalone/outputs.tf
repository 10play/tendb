output "instance_id" {
  value = module.engine.instance_id
}

output "ssm_prefix" {
  description = "Point tendb.json's ssmPrefix here."
  value       = module.engine.ssm_prefix
}

output "cli_discovery" {
  value = module.engine.ssm_parameter_names
}

output "client_iam_policy_arn" {
  value = module.engine.client_iam_policy_arn
}

output "console_url" {
  value = var.console_domain != null ? "https://${var.console_domain}/" : null
}

output "console_oauth_redirect_uri" {
  value = var.console_domain != null ? "https://${var.console_domain}/oauth2/callback" : null
}

output "console_public_ip" {
  value = var.console_on_engine ? aws_eip.console[0].public_ip : (var.enable_console ? module.console[0].required_dns_record : null)
}

output "pkg_bucket" {
  description = "Package bucket the engine-host console updater polls."
  value       = var.console_on_engine && var.package_tarball_path != null ? aws_s3_bucket.pkg[0].id : null
}
