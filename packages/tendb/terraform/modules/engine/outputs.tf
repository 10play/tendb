output "instance_id" {
  value = aws_instance.this.id
}

output "private_ip" {
  value = aws_instance.this.private_ip
}

output "public_ip" {
  value = aws_instance.this.public_ip
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "instance_role_name" {
  description = "Attach extra policies here (e.g. more secrets for future sync sources)."
  value       = aws_iam_role.this.name
}

output "instance_role_arn" {
  value = aws_iam_role.this.arn
}

output "ssm_prefix" {
  value = local.ssm_prefix
}

output "ssm_parameter_names" {
  description = "The tendb CLI's discovery contract."
  value = {
    instance_id        = aws_ssm_parameter.instance_id.name
    host               = aws_ssm_parameter.host.name
    verification_token = aws_ssm_parameter.token.name
    dbname             = aws_ssm_parameter.dbname.name
    port_pool          = aws_ssm_parameter.port_pool.name
  }
}

output "api_port" {
  value = 2345
}

output "clone_port_range" {
  value = { from = local.port_from, to = local.port_to }
}

output "client_iam_policy_json" {
  description = "Attach to CI/operator principals: SSM session access (tag-conditioned) + discovery/token params."
  value       = data.aws_iam_policy_document.client.json
}

output "client_iam_policy_arn" {
  value = var.create_client_iam_policy ? aws_iam_policy.client[0].arn : null
}
