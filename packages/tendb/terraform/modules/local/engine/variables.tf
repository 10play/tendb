variable "name" {
  description = "Deployment name; container names and the default param prefix derive from it."
  type        = string
  default     = "tendb"
}

variable "state_dir" {
  description = <<-EOT
    Absolute host directory for params.json and the rendered engine config.
    The CLI reads the same directory (tendb.json `stateDir` / TENDB_STATE_DIR).
    Must live under a path the docker-host VM mounts (e.g. inside $HOME with
    colima).
  EOT
  type        = string
}

variable "source_url" {
  description = "Postgres URL of the source database, as reachable FROM the docker host (e.g. postgres://user:pass@172.17.0.1:5455/appdb for a sibling container)."
  type        = string
  sensitive   = true
}

variable "size" {
  description = "T-shirt size (port-pool width, shm, per-clone configs). Host RAM/disk are the VM's problem — see scripts/host-setup.sh."
  type        = string
  default     = "small"
}

variable "param_prefix" {
  description = "Engine-contract namespace (params.json keys)."
  type        = string
  default     = null
}

variable "dblab_dir" {
  description = "ZFS pool mount dir INSIDE the docker-host VM (created by scripts/host-setup.sh)."
  type        = string
  default     = "/var/lib/dblab"
}

variable "server_image" {
  description = "DBLab server image (amd64; runs under Rosetta on Apple Silicon)."
  type        = string
  default     = "postgresai/dblab-server:4.1.3"
}

variable "postgres_major_version" {
  description = "Must match the source's major version — clone image compatibility."
  type        = string
}

variable "clone_image" {
  description = "Override the clone Postgres image (default derives from postgres_major_version)."
  type        = string
  default     = null
}

variable "streaming_snapshots" {
  description = "Streaming mode: snapshots come from tendb-snapshotd instead of dump/restore jobs."
  type        = bool
  default     = false
}

variable "refresh_cron" {
  description = "Dump/restore refresh schedule (dump mode only)."
  type        = string
  default     = "0 3 * * *"
}

variable "skip_start_refresh" {
  description = "Skip the initial dump/restore on engine start."
  type        = bool
  default     = false
}

variable "dump_exclude_extensions" {
  description = "Provider-proprietary extensions to exclude from dumps (e.g. pg_session_jwt for Neon sources)."
  type        = list(string)
  default     = []
}

variable "ui_enabled" {
  description = "DBLab embedded UI on 127.0.0.1:2346."
  type        = bool
  default     = true
}

variable "ui_image" {
  type    = string
  default = "postgresai/ce-ui:latest"
}

variable "max_idle_minutes" {
  description = "Leaked-clone reaper."
  type        = number
  default     = 120
}

variable "logs_retention_days" {
  type    = number
  default = 7
}

variable "snapshotd_context" {
  description = "Build context of the snapshotd image (packages/tendb/snapshotd)."
  type        = string
  default     = null
}
