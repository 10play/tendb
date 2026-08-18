output "url" {
  value = "https://${var.domain}"
}

output "public_ip" {
  value = aws_eip.this.public_ip
}

output "instance_id" {
  value = aws_instance.this.id
}

output "security_group_id" {
  description = "Pass into the engine module's allowed_security_group_ids so the console can reach the API + clone ports."
  value       = aws_security_group.this.id
}

output "required_dns_record" {
  description = "When hosted_zone_id is null, create this record at your DNS provider (Caddy retries TLS issuance until it resolves)."
  value       = var.hosted_zone_id == null ? "${var.domain}. 300 IN A ${aws_eip.this.public_ip}" : null
}

output "oauth_redirect_uri" {
  description = "Add this as an authorized redirect URI on the Google OAuth client."
  value       = "https://${var.domain}/oauth2/callback"
}
