# Platform-neutral numbers (disk sizing, port pool, shm, per-clone postgres
# configs, dump/restore parallelism) come from the shared presets module;
# only the machine-type mapping is Azure's.
module "presets" {
  source = "../../common/presets"
  size   = var.size
}

locals {
  # Memory mirrors the AWS presets: 4 / 16 / 32 / 64 GB.
  vm_sizes = {
    small  = "Standard_B2s"
    medium = "Standard_E2s_v5"
    large  = "Standard_E4s_v5"
    xlarge = "Standard_E8s_v5"
  }

  vm_size               = coalesce(var.vm_size, local.vm_sizes[var.size])
  root_volume_gb        = coalesce(var.root_volume_gb, module.presets.root_volume_gb)
  data_volume_gb        = coalesce(var.data_volume_gb, module.presets.data_volume_gb)
  shm_size              = coalesce(var.shm_size, module.presets.shm_size)
  dump_parallel_jobs    = coalesce(var.dump_parallel_jobs, module.presets.dump_parallel_jobs)
  restore_parallel_jobs = coalesce(var.restore_parallel_jobs, module.presets.restore_parallel_jobs)

  # These may be null all the way through (StandardSSD baseline), so no coalesce.
  data_volume_iops       = var.data_volume_iops != null ? var.data_volume_iops : module.presets.data_volume_iops
  data_volume_throughput = var.data_volume_throughput != null ? var.data_volume_throughput : module.presets.data_volume_throughput

  # Provisioned-performance presets (xlarge) land on PremiumV2 — at 1 TB the
  # StandardSSD baseline would make restore crawl.
  data_disk_type = coalesce(
    var.data_disk_storage_account_type,
    local.data_volume_iops != null ? "PremiumV2_LRS" : "StandardSSD_LRS",
  )

  port_from = var.clone_port_range != null ? var.clone_port_range.from : module.presets.port_from
  port_to   = var.clone_port_range != null ? var.clone_port_range.to : module.presets.port_to

  # Overrides win; pg_stat_statements ships in every size.
  postgres_configs = merge(
    module.presets.postgres_configs,
    { shared_preload_libraries = "pg_stat_statements" },
    var.postgres_configs,
  )

  param_prefix = coalesce(var.param_prefix, "/${var.name}")
  # Key Vault mapping of the contract prefix: strip the leading /, then / → -.
  secret_prefix = replace(trimprefix(local.param_prefix, "/"), "/", "-")

  clone_image = coalesce(var.clone_image, "postgresai/extended-postgres:${var.postgres_major_version}-0.8.0")

  vault_id = var.key_vault_id != null ? var.key_vault_id : azurerm_key_vault.this[0].id
  vault_name = (
    var.key_vault_id != null
    ? element(split("/", var.key_vault_id), length(split("/", var.key_vault_id)) - 1)
    : azurerm_key_vault.this[0].name
  )

  bastion_host_id = var.create_bastion ? azurerm_bastion_host.this[0].id : var.bastion_host_id
}
