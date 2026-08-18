variable "name" {
  type    = string
  default = "tendb"
}

variable "region" {
  type    = string
  default = "eu-north-1"
}

variable "size" {
  type    = string
  default = "small"
}

variable "postgres_major_version" {
  type = number
}

variable "source_secret_arn" {
  type = string
}

variable "source_secret_json_key" {
  type    = string
  default = null
}

variable "dump_exclude_extensions" {
  type    = list(string)
  default = []
}

# --- optional hosted console ---

variable "enable_console" {
  type    = bool
  default = false
}

variable "console_domain" {
  type    = string
  default = null
}

variable "hosted_zone_id" {
  type    = string
  default = null
}

variable "acme_email" {
  type    = string
  default = null
}

variable "oauth_secret_arn" {
  type    = string
  default = null
}

variable "allowed_email_domains" {
  type    = list(string)
  default = ["10play.dev"]
}

variable "package_tarball_path" {
  type    = string
  default = null
}

variable "sync_target_port" {
  type    = number
  default = null
}

variable "console_instance_type" {
  type    = string
  default = "t3.small"
}

variable "streaming_snapshots" {
  type    = bool
  default = false
}

# Pin for existing deploys: the module otherwise tracks Canonical's "current"
# Ubuntu 24.04 AMI, and an AMI bump REPLACES the engine (destroys the pool).
variable "engine_ami_id" {
  type    = string
  default = null
}

# Serve the console from the engine host itself (Caddy + oauth2-proxy + the
# CLI package on the same box): opens 80/443 on the engine SG and grants its
# role the console's extra permissions. See modules/engine/README.md.
variable "console_on_engine" {
  type    = bool
  default = false
}
