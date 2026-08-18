output "url" {
  value = "https://${var.domain}"
}

output "public_ip" {
  value = azurerm_public_ip.this.ip_address
}

output "vm_id" {
  value = azurerm_linux_virtual_machine.this.id
}

output "principal_id" {
  value = azurerm_linux_virtual_machine.this.identity[0].principal_id
}

output "required_dns_record" {
  description = "When dns_zone_name is null, create this record at your DNS provider (Caddy retries TLS issuance until it resolves)."
  value       = var.dns_zone_name == null ? "${var.domain}. 300 IN A ${azurerm_public_ip.this.ip_address}" : null
}

output "oauth_redirect_uri" {
  description = "Add this as an authorized redirect URI on the Google OAuth client."
  value       = "https://${var.domain}/oauth2/callback"
}
