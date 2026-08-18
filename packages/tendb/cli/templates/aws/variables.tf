variable "name" {
  type    = string
  default = "tendb"
}

variable "region" {
  type = string
}

variable "size" {
  description = "small | medium | large | xlarge."
  type        = string
  default     = "small"
}

variable "postgres_major_version" {
  description = "Postgres major of the SOURCE database — the clone image major must match."
  type        = number
}

variable "source_secret_arn" {
  description = "Secrets Manager ARN holding the source Postgres URL (created out of band)."
  type        = string
}

variable "source_secret_json_key" {
  description = "JSON key inside the secret holding the URL. null → the whole value is the URL."
  type        = string
  default     = null
}

variable "dump_exclude_extensions" {
  description = "Provider-proprietary extensions that break restore (e.g. Neon's pg_session_jwt)."
  type        = list(string)
  default     = []
}

variable "sync_target_port" {
  type    = number
  default = null
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
