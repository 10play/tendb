variable "project" {
  type = string
}

variable "region" {
  type = string
}

variable "zone" {
  type = string
}

variable "name" {
  type    = string
  default = "tendb"
}

variable "network_mode" {
  description = "public (engine gets an external IP for egress) or nat (Cloud NAT, no external IPs)."
  type        = string
  default     = "public"
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

variable "source_secret_id" {
  description = "Secret Manager secret id holding the source Postgres URL (created out of band)."
  type        = string
}

variable "source_secret_json_key" {
  type    = string
  default = null
}

variable "dump_exclude_extensions" {
  type    = list(string)
  default = []
}

variable "streaming_snapshots" {
  type    = bool
  default = false
}

variable "sync_target_port" {
  type    = number
  default = null
}
