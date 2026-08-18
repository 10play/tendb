variable "name" {
  type    = string
  default = "tendb-console"
}

variable "project" {
  description = "null → the provider's project."
  type        = string
  default     = null
}

variable "zone" {
  description = "Zone for the console VM (e.g. us-central1-a); its region hosts the static IP."
  type        = string
}

variable "network_self_link" {
  description = "VPC network — the 80/443 firewall rule attaches here."
  type        = string
}

variable "subnet_self_link" {
  description = "Subnetwork for the console host — the console terminates HTTPS itself (Caddy + Let's Encrypt on 80/443 via its external IP)."
  type        = string
}

variable "machine_type" {
  type    = string
  default = "e2-small" # node + caddy + oauth2-proxy need >1 GB
}

variable "labels" {
  type    = map(string)
  default = {}
}

# ---------------------------------------------------------------------------
# Domain / TLS. Caddy issues Let's Encrypt certs automatically once the
# domain resolves to this instance's static IP.
# ---------------------------------------------------------------------------

variable "domain" {
  description = "FQDN the console is served on (e.g. dbconsole.10play.dev). Also determines the Google OAuth redirect URI: https://<domain>/oauth2/callback."
  type        = string
}

variable "managed_zone" {
  description = "Cloud DNS managed zone name to create the A record in. null → DNS is managed elsewhere; create the A record (see the required_dns_record output) yourself."
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
# Secret Manager as JSON: {"client_id": "...", "client_secret": "..."}.
# ---------------------------------------------------------------------------

variable "oauth_secret_id" {
  description = "Secret Manager secret id (short name, same project) holding the Google OAuth client JSON. Pulled by the HOST at boot — never transits Terraform state."
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
  description = "Local path to the packed CLI (`pnpm pack` in tendb/cli). Uploaded to GCS and installed on the host. Alternative: set npm_package_spec once published."
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

variable "engine_param_prefix" {
  description = "The engine module's param_prefix output — the console discovers the engine host, token, and dbname from the mapped secrets. Apply the engine first: the per-secret grants here bind to secrets it creates."
  type        = string
}

variable "console_port" {
  description = "Loopback port the console server listens on (behind oauth2-proxy)."
  type        = number
  default     = 4400
}
