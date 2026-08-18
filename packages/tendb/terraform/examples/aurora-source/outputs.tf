output "endpoint" {
  value = aws_rds_cluster.this.endpoint
}

output "database" {
  value = var.database
}

output "publisher_url_ssm_parameter" {
  value = aws_ssm_parameter.publisher_url.name
}

output "security_group_id" {
  value = aws_security_group.aurora.id
}
