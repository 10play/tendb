variable "name" {
  type    = string
  default = "tendb-aurora-source"
}

variable "region" {
  type    = string
  default = "eu-north-1"
}

variable "engine_version" {
  description = "Aurora PostgreSQL version. Keep the major aligned with the Neon subscriber."
  type        = string
  default     = "18.4"
}

variable "database" {
  description = "Database name — mirrors the Neon subscriber database for symmetry."
  type        = string
  default     = "tendb"
}

variable "engine_ssm_prefix" {
  description = "The tendb engine's SSM prefix; the publisher URL is published under <prefix>/replication/."
  type        = string
  default     = "/tendb"
}

# Clients that must reach Aurora:5432 — the engine host's public IP (the
# sync-target subscription dials out from it; ephemeral, no EIP — re-apply
# after an engine stop/start) and the hosted console's EIP (its replication
# status probe).
variable "client_cidrs" {
  type    = list(string)
  default = []
}

variable "admin_cidrs" {
  description = "Operator CIDRs allowed to reach 5432 for seeding and psql."
  type        = list(string)
  default     = []
}

