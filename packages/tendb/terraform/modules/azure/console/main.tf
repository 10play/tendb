# Deployed tendb console: the same server `tendb console` runs locally,
# hosted in-VNet next to the engine (direct TCP — no Bastion tunnels), behind
# oauth2-proxy (Google, domain-restricted) and Caddy (automatic HTTPS).
#
# Request path:  browser → :443 Caddy → :4180 oauth2-proxy → :4400 console
# The console itself binds loopback only; the token and clone credentials
# never reach the browser.

locals {
  vault_name = element(split("/", var.key_vault_id), length(split("/", var.key_vault_id)) - 1)
  shim_body  = file("${path.module}/../../../../snapshotd/shims/azure.sh")

  pkg_blob_url = var.package_tarball_path != null ? azurerm_storage_blob.pkg[0].url : ""

  dns_label = var.dns_zone_name == null ? null : (
    var.domain == var.dns_zone_name ? "@" : trimsuffix(var.domain, ".${var.dns_zone_name}")
  )
}

# ---------------------------------------------------------------------------
# Package delivery: local tarball → private blob the host pulls at boot with
# an MSI token (the updater polls its ETag for in-place releases).
# ---------------------------------------------------------------------------

# Storage account names: global, 3–24 chars, lowercase alphanumeric only.
resource "random_string" "pkg" {
  count = var.package_tarball_path != null ? 1 : 0

  length  = 8
  upper   = false
  special = false
}

resource "azurerm_storage_account" "pkg" {
  count = var.package_tarball_path != null ? 1 : 0

  name                            = substr("${replace(var.name, "-", "")}${random_string.pkg[0].result}", 0, 24)
  resource_group_name             = var.resource_group_name
  location                        = var.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  allow_nested_items_to_be_public = false
  tags                            = var.tags
}

resource "azurerm_storage_container" "pkg" {
  count = var.package_tarball_path != null ? 1 : 0

  name                  = "pkg"
  storage_account_id    = azurerm_storage_account.pkg[0].id
  container_access_type = "private"
}

resource "azurerm_storage_blob" "pkg" {
  count = var.package_tarball_path != null ? 1 : 0

  name                   = "tendb.tgz"
  storage_account_name   = azurerm_storage_account.pkg[0].name
  storage_container_name = azurerm_storage_container.pkg[0].name
  type                   = "Block"
  source                 = var.package_tarball_path
  # Content change re-uploads the blob; the new ETag is the on-host updater's
  # release signal.
  content_md5 = filemd5(var.package_tarball_path)
}

# ---------------------------------------------------------------------------
# Network: public IP for Caddy, NSG open on 80/443 only (auth is
# oauth2-proxy's job, TLS is Caddy's).
# ---------------------------------------------------------------------------

resource "azurerm_public_ip" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_network_security_group" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_network_security_rule" "web" {
  name                        = "http-https"
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_ranges     = ["80", "443"] # 80: ACME challenges + redirect
  source_address_prefix       = "Internet"
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.this.name
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
    public_ip_address_id          = azurerm_public_ip.this.id
  }
}

resource "azurerm_network_interface_security_group_association" "this" {
  network_interface_id      = azurerm_network_interface.this.id
  network_security_group_id = azurerm_network_security_group.this.id
}

# ---------------------------------------------------------------------------
# Instance + identity grants
# ---------------------------------------------------------------------------

resource "azurerm_linux_virtual_machine" "this" {
  name                  = var.name
  resource_group_name   = var.resource_group_name
  location              = var.location
  size                  = var.vm_size
  network_interface_ids = [azurerm_network_interface.this.id]
  tags                  = var.tags

  admin_username = var.admin_username
  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  identity {
    type = "SystemAssigned"
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 30 # the az CLI alone is >1 GB installed
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/templates/init.sh.tpl", {
    domain                = var.domain
    acme_email            = var.acme_email
    allowed_email_domains = var.allowed_email_domains
    oauth2_proxy_version  = var.oauth2_proxy_version
    console_port          = var.console_port
    oauth_secret_name     = var.oauth_secret_name
    engine_param_prefix   = var.engine_param_prefix
    vault_name            = local.vault_name
    shim_body             = local.shim_body
    pkg_blob_url          = local.pkg_blob_url
    npm_package_spec      = var.npm_package_spec != null ? var.npm_package_spec : ""
    # No package fingerprint here on purpose: releases go through the on-host
    # updater (blob ETag poll → npm install → service restart, ~20s). The
    # instance is replaced only when the bootstrap itself changes.
  }))
}

# Reads host/token/dbname + the OAuth secret, writes the runtime namespaces
# (snapshots/*, alerts/*, schema/*). Key Vault RBAC cannot scope to
# name patterns, so Officer on the vault is the tightest grant.
resource "azurerm_role_assignment" "vault" {
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = azurerm_linux_virtual_machine.this.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "pkg" {
  count = var.package_tarball_path != null ? 1 : 0

  scope                = azurerm_storage_account.pkg[0].id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_linux_virtual_machine.this.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_dns_a_record" "this" {
  count = var.dns_zone_name != null ? 1 : 0

  name                = local.dns_label
  zone_name           = var.dns_zone_name
  resource_group_name = coalesce(var.dns_zone_resource_group_name, var.resource_group_name)
  ttl                 = 300
  records             = [azurerm_public_ip.this.ip_address]
  tags                = var.tags
}
