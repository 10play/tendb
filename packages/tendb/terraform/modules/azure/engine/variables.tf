# ---------------------------------------------------------------------------
# Identity / placement
# ---------------------------------------------------------------------------

variable "name" {
  description = "Prefix for every named resource (NSG, NIC, vault, VM name)."
  type        = string
  default     = "tendb"

  validation {
    # Feeds Key Vault (24-char global) and secret names — keep it tame.
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.name))
    error_message = "name must be lowercase alphanumeric/hyphen, start with a letter, and be at most 21 chars."
  }
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "subnet_id" {
  description = "Subnet for the engine host's NIC."
  type        = string
}

variable "zone" {
  description = "Availability zone for the VM + data disk. PremiumV2 disks (the xlarge preset) require one in most regions."
  type        = string
  default     = null
}

variable "admin_username" {
  type    = string
  default = "ubuntu"
}

variable "admin_ssh_public_key" {
  description = "azurerm refuses key-less Linux VMs. SSH still has no public path — admin rides the Bastion (az network bastion ssh)."
  type        = string
}

variable "tags" {
  description = "Extra tags merged onto every resource."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Client access (who may reach the DBLab API + clone Postgres ports in-VNet).
# Bastion tunnels work regardless — these govern direct TCP only.
# ---------------------------------------------------------------------------

variable "client_cidrs" {
  description = "CIDRs allowed to reach 2345 + the clone port range (typically the VNet CIDR)."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Bastion (the CLI's tunnel transport — see docs/ENGINE-CONTRACT.md)
# ---------------------------------------------------------------------------

variable "create_bastion" {
  description = "Provision a Standard-SKU Bastion with native-client tunneling (~$140/mo idle). false → bring one via bastion_host_id."
  type        = bool
  default     = true

  validation {
    condition     = var.create_bastion || var.bastion_host_id != null
    error_message = "create_bastion = false requires bastion_host_id."
  }

  validation {
    condition     = !var.create_bastion || var.bastion_subnet_id != null
    error_message = "create_bastion = true requires bastion_subnet_id (the AzureBastionSubnet)."
  }
}

variable "bastion_host_id" {
  description = "Existing Standard-SKU Bastion (tunneling enabled) to publish as the bastion-id contract param instead of creating one."
  type        = string
  default     = null
}

variable "bastion_subnet_id" {
  description = "The AzureBastionSubnet (exact name mandated by Azure, /26 minimum) — the network module creates it."
  type        = string
  default     = null
}

variable "bastion_subnet_cidr" {
  description = "AzureBastionSubnet CIDR. Bastion dials the VM in-VNet from this range, so the NSG must admit it on every engine port."
  type        = string
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

variable "vm_size" {
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

variable "data_volume_iops" {
  type    = number
  default = null # StandardSSD baseline; PremiumV2 provisioned at xlarge
}

variable "data_volume_throughput" {
  type    = number
  default = null # MB/s
}

variable "data_disk_storage_account_type" {
  description = "Override the derived disk type (StandardSSD_LRS, or PremiumV2_LRS when the preset provisions IOPS)."
  type        = string
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

variable "source_secret_name" {
  description = "Key Vault secret (in THIS module's vault) holding the source Postgres URL, created out of band — see the README's bootstrap order. The HOST pulls it at boot via its managed identity; it never transits Terraform state or custom_data."
  type        = string
}

variable "source_secret_json_key" {
  description = "JSON key within the secret that holds the URL (e.g. NEON_DATABASE_URL). null → the whole secret value IS the URL."
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

variable "streaming_snapshots" {
  description = "Streaming-source mode: no scheduled dump/restore (the sync target lives on the pool and tendb-snapshotd takes O(1) ZFS snapshots); clones get max_logical_replication_workers=0 so they can never fight the sync target for the publisher's slot."
  type        = bool
  default     = false
}

variable "sync_target_port" {
  description = "Optional on-host sync-target Postgres port opened to client_cidrs (streaming-source setups)."
  type        = number
  default     = null
}

variable "console_ingress" {
  description = "Open 80/443 to the world for a co-hosted console (Caddy on this host). NSG-rule-only; no custom_data impact."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Key Vault / token
# ---------------------------------------------------------------------------

variable "key_vault_id" {
  description = "Existing RBAC-mode Key Vault to publish discovery secrets into. null → create one (name gets a random suffix; vault names are global)."
  type        = string
  default     = null
}

variable "param_prefix" {
  description = "Engine-contract namespace for discovery params (instance-id, host, verification-token, dbname, port-pool, bastion-id). null → /<name>. Mapped onto Key Vault secret names as /a/b → a-b; the tendb CLI reads these."
  type        = string
  default     = null
}

variable "token_secret_version" {
  description = "Bump to rotate the API verification token. CAUTION: clone passwords are derived from the token — existing clones keep their old passwords."
  type        = number
  default     = 1
}

variable "grant_deployer_secrets_officer" {
  description = "Assign Key Vault Secrets Officer to the principal running terraform. RBAC vaults grant NO data-plane access by default — without this (or an equivalent out-of-band grant) terraform cannot write the discovery secrets."
  type        = bool
  default     = true
}
