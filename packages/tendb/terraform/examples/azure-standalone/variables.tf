variable "subscription_id" {
  description = "Azure subscription to deploy into. null → ARM_SUBSCRIPTION_ID."
  type        = string
  default     = null
}

variable "location" {
  type    = string
  default = "northeurope"
}

variable "name" {
  type    = string
  default = "tendb"
}

variable "size" {
  description = "small | medium | large | xlarge."
  type        = string
  default     = "small"
}

variable "postgres_major_version" {
  description = "Postgres major of the SOURCE database (the clone image must match)."
  type        = number
}

variable "source_secret_name" {
  description = "Key Vault secret holding the source Postgres URL — created out of band in the engine vault (see main.tf's bootstrap note)."
  type        = string
  default     = "tendb-source-url"
}

variable "source_secret_json_key" {
  description = "JSON key inside the secret holding the URL. null → the whole value is the URL."
  type        = string
  default     = null
}

variable "dump_exclude_extensions" {
  type    = list(string)
  default = []
}

variable "streaming_snapshots" {
  type    = bool
  default = false
}

variable "admin_ssh_public_key" {
  description = "SSH public key for the VMs (azurerm requires one; access rides the Bastion)."
  type        = string
}

variable "network_mode" {
  description = "default | nat — see modules/azure/network/README.md (Azure retired default outbound access for subnets created after 2025-09-30)."
  type        = string
  default     = "default"
}

# --- optional hosted console ----------------------------------------------

variable "enable_console" {
  type    = bool
  default = false
}

variable "console_domain" {
  description = "FQDN for the console (required when enable_console)."
  type        = string
  default     = null
}

variable "acme_email" {
  description = "Let's Encrypt contact email (required when enable_console)."
  type        = string
  default     = null
}

variable "oauth_secret_name" {
  description = "Key Vault secret with the Google OAuth client JSON (in the engine vault, created out of band)."
  type        = string
  default     = "tendb-oauth-client"
}

variable "allowed_email_domains" {
  type    = list(string)
  default = ["10play.dev"]
}

variable "package_tarball_path" {
  description = "Packed CLI tarball to host from a private blob. XOR npm_package_spec."
  type        = string
  default     = null
}

variable "npm_package_spec" {
  type    = string
  default = null
}
