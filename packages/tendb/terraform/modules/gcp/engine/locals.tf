# Platform-neutral numbers (disks, ports, shm, per-clone postgres configs)
# come from the shared presets; machine types are the per-platform half.
module "presets" {
  source = "../../common/presets"
  size   = var.size
}

locals {
  # RAM tiers match the AWS presets (t3.medium/r6i.large/xlarge/2xlarge).
  machine_types = {
    small  = "e2-medium"    # 4 GB
    medium = "n2-highmem-2" # 16 GB
    large  = "n2-highmem-4" # 32 GB
    xlarge = "n2-highmem-8" # 64 GB
  }

  machine_type          = coalesce(var.machine_type, local.machine_types[var.size])
  root_volume_gb        = coalesce(var.root_volume_gb, module.presets.root_volume_gb)
  data_volume_gb        = coalesce(var.data_volume_gb, module.presets.data_volume_gb)
  shm_size              = coalesce(var.shm_size, module.presets.shm_size)
  dump_parallel_jobs    = coalesce(var.dump_parallel_jobs, module.presets.dump_parallel_jobs)
  restore_parallel_jobs = coalesce(var.restore_parallel_jobs, module.presets.restore_parallel_jobs)

  port_from = var.clone_port_range != null ? var.clone_port_range.from : module.presets.port_from
  port_to   = var.clone_port_range != null ? var.clone_port_range.to : module.presets.port_to

  # Overrides win; pg_stat_statements ships in every size.
  postgres_configs = merge(
    module.presets.postgres_configs,
    { shared_preload_libraries = "pg_stat_statements" },
    var.postgres_configs,
  )

  param_prefix = coalesce(var.param_prefix, "/${var.name}")
  clone_image  = coalesce(var.clone_image, "postgresai/extended-postgres:${var.postgres_major_version}-0.8.0")
  project      = coalesce(var.project, data.google_client_config.current.project)

  # The shim resolves the pool disk as /dev/disk/by-id/google-<device_name>.
  data_device_name = "tendb-data"
  network_tag      = "tendb-engine-${var.name}"

  # Every contract key (docs/ENGINE-CONTRACT.md). Terraform creates them ALL —
  # runtime namespaces included — so the engine SA gets per-secret grants only
  # and pf_put_param's create-if-missing path never fires.
  contract_keys = [
    "instance-id",
    "host",
    "verification-token",
    "dbname",
    "port-pool",
    "snapshots/config",
    "snapshots/request",
    "schema/config",
    "schema/sync-request",
    "alerts/slack-webhook",
    "console-url",
    "replication/publisher-url",
    "replication/subscriber-url",
  ]

  # "/tendb/a/b" → "tendb_a_b": strip the leading "/", then "/" → "_".
  secret_ids = {
    for k in local.contract_keys :
    k => replace(trimprefix("${local.param_prefix}/${k}", "/"), "/", "_")
  }

  # verification-token is its own resource (write-only version — token.tf).
  param_secret_ids = { for k, v in local.secret_ids : k => v if k != "verification-token" }

  # What `tendb snapshots|schema` writes; the rest is read-only for clients.
  client_write_keys = ["snapshots/config", "snapshots/request", "schema/config", "schema/sync-request"]
}

data "google_client_config" "current" {}
