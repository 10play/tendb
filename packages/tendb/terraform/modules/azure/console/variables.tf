variable "name" {
  type    = string
  default = "tendb-console"
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "subnet_id" {
  description = "Subnet for the console NIC. The console terminates HTTPS itself (Caddy + Let's Encrypt on 80/443 behind a public IP)."
  type        = string
}

variable "vm_size" {
  type    = string
  default = "Standard_B2s" # node + caddy + oauth2-proxy + az need >1 GB
}

variable "admin_username" {
  type    = string
  default = "ubuntu"
}

variable "admin_ssh_public_key" {
  description = "azurerm refuses key-less Linux VMs; no inbound SSH rule exists — reach the host via a Bastion in the same VNet if needed."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

# ---------------------------------------------------------------------------
# Domain / TLS. Caddy issues Let's Encrypt certs automatically once the
# domain resolves to this instance's public IP.
# ---------------------------------------------------------------------------

variable "domain" {
  description = "FQDN the console is served on (e.g. dbconsole.10play.dev). Also determines the Google OAuth redirect URI: https://<domain>/oauth2/callback."
  type        = string
}

variable "dns_zone_name" {
  description = "Azure DNS zone to create the A record in (var.domain must live under it). null → DNS is managed elsewhere; create the A record (see the required_dns_record output) yourself."
  type        = string
  default     = null
}

variable "dns_zone_resource_group_name" {
  description = "Resource group of the DNS zone. null → var.resource_group_name."
  type        = string
  default     = null
}

variable "acme_email" {
  description = "Contact email for Let's Encrypt registration."
  type        = string
}

# ---------------------------------------------------------------------------
# Auth: Google OAuth via oauth2-proxy. The OAuth client is created by hand in
# the Google Cloud console (that step cannot be terraformed) and stored in
# the engine's Key Vault as JSON: {"client_id": "...", "client_secret": "..."}.
# ---------------------------------------------------------------------------

variable "oauth_secret_name" {
  description = "Key Vault secret (in the engine's vault) holding the Google OAuth client JSON. Pulled by the HOST at boot — never transits Terraform state."
  type        = string
}

variable "allowed_email_domains" {
  description = "Google account domains allowed through (oauth2-proxy --email-domain)."
  type        = list(string)
  default     = ["10play.dev"]
}

variable "oauth2_proxy_version" {
  type    = string
  default = "7.8.1"
}

# ---------------------------------------------------------------------------
# The tendb package + engine wiring
# ---------------------------------------------------------------------------

variable "package_tarball_path" {
  description = "Local path to the packed CLI (`pnpm pack` in tendb/cli). Uploaded to a private blob and installed on the host. Alternative: set npm_package_spec once published."
  type        = string
  default     = null
}

variable "npm_package_spec" {
  description = "npm spec to install instead of a local tarball (e.g. @10play/tendb@0.1.0). Exactly one of package_tarball_path / npm_package_spec must be set."
  type        = string
  default     = null

  validation {
    condition     = (var.package_tarball_path == null) != (var.npm_package_spec == null)
    error_message = "Set exactly one of package_tarball_path or npm_package_spec."
  }
}

variable "key_vault_id" {
  description = "The engine module's key_vault_id output — discovery params, the token, and the OAuth secret live there."
  type        = string
}

variable "engine_param_prefix" {
  description = "The engine module's param_prefix output — the console discovers the engine host, token, and dbname under it."
  type        = string
}

variable "console_port" {
  description = "Loopback port the console server listens on (behind oauth2-proxy)."
  type        = number
  default     = 4400
}
