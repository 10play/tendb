# `tendb up` folds this straight into tendb.json.
output "cli_discovery" {
  value = jsonencode({
    platform  = "aws"
    ssmPrefix = module.engine.ssm_prefix
    region    = var.region
  })
}

output "instance_id" {
  value = module.engine.instance_id
}

output "ssm_prefix" {
  description = "Point tendb.json's ssmPrefix here."
  value       = module.engine.ssm_prefix
}

output "client_iam_policy_arn" {
  description = "Attach to every CLI/CI principal (SSM discovery + tunnel access)."
  value       = module.engine.client_iam_policy_arn
}
