output "url" {
  value = "https://${var.domain}"
}

output "public_ip" {
  value = google_compute_address.this.address
}

output "instance_path" {
  value = "projects/${local.project}/zones/${var.zone}/instances/${google_compute_instance.this.name}"
}

output "required_dns_record" {
  description = "When managed_zone is null, create this record at your DNS provider (Caddy retries TLS issuance until it resolves)."
  value       = var.managed_zone == null ? "${var.domain}. 300 IN A ${google_compute_address.this.address}" : null
}

output "oauth_redirect_uri" {
  description = "Add this as an authorized redirect URI on the Google OAuth client."
  value       = "https://${var.domain}/oauth2/callback"
}
