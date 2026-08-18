# DBLab Engine host (postgres.ai) — ZFS thin clones of a source Postgres
# database. Private-first: no public IP, no inbound SSH path; admin and CLI
# tunnels ride Azure Bastion (bastion.tf), API/DB access in-VNet only.

locals {
  shim_body = file("${path.module}/../../../../snapshotd/shims/azure.sh")

  # Installed at /etc/tendb/platform-shim.sh for tendb-snapshotd: azure.sh
  # verbatim with the vault baked in (snapshotd.env only carries the prefix).
  runtime_shim = <<-EOT
    export TENDB_AZURE_VAULT="${local.vault_name}"
    ${local.shim_body}
  EOT

  # Boot variant: same shim plus the RBAC-propagation gate (see the template).
  boot_shim = templatefile("${path.module}/templates/shim.sh.tpl", {
    vault_name   = local.vault_name
    param_prefix = local.param_prefix
    shim_body    = local.shim_body
  })

  # Runtime values are SHELL variables ($TOKEN, $DB_*, $PRIVATE_IP): init-core
  # expands them in its unquoted heredoc after fetching credentials on-host —
  # they never appear in the rendered template or Terraform state.
  server_yml = templatefile("${path.module}/../../common/engine-init/templates/server-yml.tpl", {
    token                 = "$TOKEN"
    ui_enabled            = var.ui_enabled
    ui_host               = "$PRIVATE_IP"
    ui_image              = var.ui_image
    clone_image           = local.clone_image
    shm_size              = local.shm_size
    streaming_snapshots   = var.streaming_snapshots
    postgres_configs      = local.postgres_configs
    port_pool_from        = local.port_from
    port_pool_to          = local.port_to
    refresh_cron          = var.refresh_cron
    skip_start_refresh    = var.skip_start_refresh
    db_name               = "$DB_NAME"
    db_host               = "$DB_HOST"
    db_port               = "$DB_PORT"
    db_user               = "$DB_USER"
    db_pass               = "$DB_PASS"
    dump_parallel_jobs    = local.dump_parallel_jobs
    restore_parallel_jobs = local.restore_parallel_jobs
    exclude_extensions    = var.dump_exclude_extensions
    access_host           = "$PRIVATE_IP"
    max_idle_minutes      = var.clone_max_idle_minutes
    logs_retention_days   = var.logs_retention_days
  })

  init_core = templatefile("${path.module}/../../common/engine-init/templates/init-core.sh.tpl", {
    server_yml             = local.server_yml
    source_secret_id       = var.source_secret_name
    source_secret_json_key = var.source_secret_json_key == null ? "" : var.source_secret_json_key
    server_image           = var.server_image
    param_prefix           = local.param_prefix
    shim_script_b64        = base64encode(local.runtime_shim)
    snapshotd_script_b64   = base64encode(file("${path.module}/../../../../snapshotd/tendb-snapshotd.sh"))
    snapshotd_unit_b64     = base64encode(file("${path.module}/../../../../snapshotd/tendb-snapshotd.service"))
  })

  # Azure caps custom_data at 64 KB base64 — this composition sits well under.
  custom_data = base64encode(join("\n", [
    "#!/usr/bin/env bash",
    local.boot_shim,
    local.init_core,
  ]))
}

resource "azurerm_network_interface" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = var.subnet_id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "this" {
  name                  = var.name
  resource_group_name   = var.resource_group_name
  location              = var.location
  size                  = local.vm_size
  zone                  = var.zone
  network_interface_ids = [azurerm_network_interface.this.id]
  tags                  = var.tags

  admin_username = var.admin_username
  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  # The vault is the host's whole credential surface (token, source URL,
  # dbname write) — see the role assignment in vault.tf.
  identity {
    type = "SystemAssigned"
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = local.root_volume_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  # CAUTION: custom_data is immutable on Azure — any init change REPLACES the
  # VM, destroying the ZFS pool with every clone on it (data re-syncs from the
  # source at boot). Grep plans for "must be replaced" before applying.
  custom_data = local.custom_data
}

# ZFS pool device. Attached at LUN 0 — the shim's pf_data_device resolves
# /dev/disk/azure/scsi1/lun0.
resource "azurerm_managed_disk" "data" {
  name                 = "${var.name}-data"
  location             = var.location
  resource_group_name  = var.resource_group_name
  zone                 = var.zone
  storage_account_type = local.data_disk_type
  create_option        = "Empty"
  disk_size_gb         = local.data_volume_gb
  # PremiumV2 only (null elsewhere): provisioned performance for xlarge.
  disk_iops_read_write = local.data_disk_type == "PremiumV2_LRS" ? local.data_volume_iops : null
  disk_mbps_read_write = local.data_disk_type == "PremiumV2_LRS" ? local.data_volume_throughput : null
  tags                 = var.tags
}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  managed_disk_id    = azurerm_managed_disk.data.id
  virtual_machine_id = azurerm_linux_virtual_machine.this.id
  lun                = 0
  caching            = "None" # ZFS owns caching; PremiumV2 forbids host caching anyway

  # Init blocks on this disk before it first touches the vault — sequencing
  # the attach after the RBAC grant gives role propagation a head start.
  depends_on = [azurerm_role_assignment.vm_secrets]
}
