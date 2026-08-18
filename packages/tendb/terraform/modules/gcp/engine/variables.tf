# ---------------------------------------------------------------------------
# Identity / placement
# ---------------------------------------------------------------------------

variable "name" {
  description = "Prefix for every named resource (instance, service account, firewalls, secret ids)."
  type        = string
  default     = "tendb"
}

variable "project" {
  description = "Project the secrets and instance path are addressed under. null → the provider's project."
  type        = string
  default     = null
}

variable "zone" {
  description = "Zone for the instance + data disk (e.g. us-central1-a)."
  type        = string
}

variable "network_self_link" {
  description = "VPC network — firewall rules attach here."
  type        = string
}

variable "subnet_self_link" {
  description = "Subnetwork for the engine host."
  type        = string
}

variable "assign_external_ip" {
  description = "Give the host an external IP for egress (pair with the network module's public mode)."
  type        = bool
  default     = false
}

variable "labels" {
  description = "Extra labels merged onto every resource that takes them."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Client access (who may reach the DBLab API + clone Postgres ports in-VPC).
# IAP tunnels work regardless — these govern direct TCP only.
# ---------------------------------------------------------------------------

variable "client_cidr_ranges" {
  description = "CIDRs allowed to reach 2345 + the clone port range (typically the subnet CIDR)."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Sizing: preset + per-knob overrides (override wins when non-null).
# No iops/throughput knobs: pd-ssd performance scales with disk size.
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

variable "machine_type" {
  type    = string
  default = null
}

variable "root_volume_gb" {
  type    = number
  default = null
}

variable "data_volume_gb" {
  description = "ZFS pool disk (thin clones + the logical dump live here)."
  type        = number
  default     = null
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

variable "source_secret_id" {
  description = "Secret Manager secret id (short name, same project) holding the source Postgres URL. Created OUT of band — the HOST pulls it at boot via its service account, so it never transits Terraform state or metadata."
  type        = string
}

variable "source_secret_json_key" {
  description = "JSON key within the secret that holds the URL (e.g. NEON_DATABASE_URL). null → the whole payload IS the URL."
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
  description = "Run DBLab's embedded UI on the host loopback (port 2346, reached via IAP tunnel)."
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
# Params / token
# ---------------------------------------------------------------------------

variable "param_prefix" {
  description = "Contract param namespace mapped onto Secret Manager ids (\"/tendb/a/b\" → \"tendb_a_b\"). null → /<name>. The tendb CLI reads these."
  type        = string
  default     = null
}

variable "token_secret_version" {
  description = "Bump to rotate the API verification token. CAUTION: clone passwords are derived from the token — existing clones keep their old passwords."
  type        = number
  default     = 1
}

variable "sync_target_port" {
  description = "Optional on-host sync-target Postgres port opened to client_cidr_ranges (streaming-source setups)."
  type        = number
  default     = null
}

variable "streaming_snapshots" {
  description = "Streaming-source mode: no scheduled dump/restore (the sync target lives on the pool and tendb-snapshotd takes O(1) ZFS snapshots); clones get max_logical_replication_workers=0 so they can never fight the sync target for the publisher's slot."
  type        = bool
  default     = false
}

variable "console_ingress" {
  description = "Open 80/443 to the world for a co-hosted console (Caddy on this host). Firewall-only; no startup-script impact."
  type        = bool
  default     = false
}
