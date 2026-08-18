# ---------------------------------------------------------------------------
# Identity / placement
# ---------------------------------------------------------------------------

variable "name" {
  description = "Prefix for every named resource (SG, IAM role, instance Name tag)."
  type        = string
  default     = "tendb"
}

variable "vpc_id" {
  description = "VPC to place the engine host in."
  type        = string
}

variable "subnet_id" {
  description = "Subnet for the engine host."
  type        = string
}

variable "associate_public_ip" {
  description = "Give the host a public IP (pair with the network module's public mode)."
  type        = bool
  default     = false
}

variable "ami_id" {
  description = "AMI override. Default: latest Ubuntu 24.04 amd64 (ZFS is one apt-get; AL2023 has no ZFS packages)."
  type        = string
  default     = null
}

variable "tags" {
  description = "Extra tags merged onto every resource."
  type        = map(string)
  default     = {}
}

variable "ssm_access_tag_value" {
  description = "Value of the Role tag on the instance. Client IAM (SSM SendCommand/StartSession) is conditioned on it, so it survives instance replacement."
  type        = string
  default     = null # null → var.name
}

# ---------------------------------------------------------------------------
# Client access (who may reach the DBLab API + clone Postgres ports in-VPC).
# SSM port-forwarding works regardless — these govern direct TCP only.
# ---------------------------------------------------------------------------

variable "allowed_security_group_ids" {
  description = "Security groups allowed to reach 2345 + the clone port range."
  type        = list(string)
  default     = []
}

variable "allowed_cidr_blocks" {
  description = "CIDRs allowed to reach 2345 + the clone port range."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Sizing: preset + per-knob overrides (override wins when non-null)
# ---------------------------------------------------------------------------

variable "size" {
  description = "T-shirt size preset: small (POC, ~6 clones), medium (sandbox), large (up to ~100 GB sources), xlarge (200 GB–1 TB sources)."
  type        = string
  default     = "small"

  validation {
    condition     = contains(["small", "medium", "large", "xlarge"], var.size)
    error_message = "size must be one of: small, medium, large, xlarge."
  }
}

variable "instance_type" {
  type    = string
  default = null
}

variable "root_volume_gb" {
  type    = number
  default = null
}

variable "data_volume_gb" {
  description = "ZFS pool volume (thin clones + the logical dump live here)."
  type        = number
  default     = null
}

variable "data_volume_iops" {
  type    = number
  default = null # gp3 default (3000)
}

variable "data_volume_throughput" {
  type    = number
  default = null # gp3 default (125 MB/s)
}

variable "clone_port_range" {
  description = "Clone Postgres port pool; its width is the hard cap on concurrent clones."
  type        = object({ from = number, to = number })
  default     = null
}

variable "postgres_configs" {
  description = "postgresql.conf settings merged OVER the preset (per clone — every clone allocates shared_buffers)."
  type        = map(string)
  default     = {}
}

variable "shm_size" {
  description = "Docker shm-size for clone containers (e.g. 1g)."
  type        = string
  default     = null
}

variable "dump_parallel_jobs" {
  type    = number
  default = null
}

variable "restore_parallel_jobs" {
  type    = number
  default = null
}

# ---------------------------------------------------------------------------
# Source database (what gets dumped + restored into the pool)
# ---------------------------------------------------------------------------

variable "source_secret_arn" {
  description = "Secrets Manager secret holding the source Postgres URL. The HOST pulls it at boot via its instance profile — it never transits Terraform state or user-data."
  type        = string
}

variable "source_secret_json_key" {
  description = "JSON key within the secret that holds the URL (e.g. NEON_DATABASE_URL). null → the whole SecretString IS the URL."
  type        = string
  default     = null
}

variable "postgres_major_version" {
  description = "Postgres major of the SOURCE database. No default on purpose: the clone image major MUST match or restore fails."
  type        = number
}

variable "clone_image" {
  description = "Clone Postgres image override. Default derives postgresai/extended-postgres:<major>-0.8.0 — override when postgres.ai's tag scheme drifts."
  type        = string
  default     = null
}

variable "server_image" {
  type    = string
  default = "postgresai/dblab-server:4.1.3"
}

variable "dump_exclude_extensions" {
  description = "Extensions excluded from pg_dump (e.g. pg_session_jwt — provider-proprietary, not installable in stock Postgres)."
  type        = list(string)
  default     = []
}

variable "refresh_cron" {
  description = "Full data refresh schedule (skipped non-destructively while clones exist)."
  type        = string
  default     = "0 2 * * *"
}

variable "skip_start_refresh" {
  description = "Skip the initial dump/restore at boot."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Engine behavior
# ---------------------------------------------------------------------------

variable "ui_enabled" {
  description = "Run DBLab's embedded UI on the host loopback (port 2346)."
  type        = bool
  default     = true
}

variable "ui_image" {
  type    = string
  default = "postgresai/ce-ui:latest"
}

variable "clone_max_idle_minutes" {
  description = "Leaked-clone reaper. Clones with active consumers never idle."
  type        = number
  default     = 1440
}

variable "logs_retention_days" {
  type    = number
  default = 3
}

# ---------------------------------------------------------------------------
# SSM / token
# ---------------------------------------------------------------------------

variable "ssm_prefix" {
  description = "SSM parameter namespace for discovery params (instance-id, host, verification-token, dbname, port-pool). null → /<name>. The tendb CLI reads these."
  type        = string
  default     = null
}

variable "token_secret_version" {
  description = "Bump to rotate the API verification token. CAUTION: clone passwords are derived from the token — existing clones keep their old passwords."
  type        = number
  default     = 1
}

variable "kms_key_id" {
  description = "KMS key for the token SecureString (default: aws/ssm)."
  type        = string
  default     = null
}

variable "create_client_iam_policy" {
  description = "Materialize client_iam_policy_json as a managed IAM policy."
  type        = bool
  default     = false
}

variable "sync_target_port" {
  description = "Optional on-host sync-target Postgres port opened to allowed_cidr_blocks (streaming-source setups)."
  type        = number
  default     = null
}

variable "streaming_snapshots" {
  description = "Streaming-source mode: no scheduled dump/restore (the sync target lives on the pool and tendb-snapshotd takes O(1) ZFS snapshots); clones get max_logical_replication_workers=0 so they can never fight the sync target for the publisher's slot."
  type        = bool
  default     = false
}

variable "console_ingress" {
  description = "Open 80/443 to the world for a co-hosted console (Caddy on this host). SG-rule-only; no user_data impact."
  type        = bool
  default     = false
}
