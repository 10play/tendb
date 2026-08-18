# Key Vault is both the platform's secret store AND its param store: every
# engine-contract key maps to one secret name (/tendb/a/b → tendb-a-b). RBAC
# mode — role assignments below are the entire ACL.

data "azurerm_client_config" "current" {}

# Vault names are GLOBAL and capped at 24 chars; the suffix keeps repeated
# deploys of the same var.name from colliding (and from tripping over
# soft-deleted remains of a destroyed one).
resource "random_string" "vault_suffix" {
  count   = var.key_vault_id == null ? 1 : 0
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_key_vault" "this" {
  count = var.key_vault_id == null ? 1 : 0

  name                = "${substr(var.name, 0, 17)}-${random_string.vault_suffix[0].result}"
  location            = var.location
  resource_group_name = var.resource_group_name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  rbac_authorization_enabled = true

  # Discovery secrets must die with the module (absent instance-id IS the
  # "platform is down" signal) — purge protection would pin them for 90 days.
  soft_delete_retention_days = 7
  purge_protection_enabled   = false

  tags = var.tags
}

# Data-plane RBAC: subscription Owner grants NO secret access by itself. The
# deploying principal writes the discovery secrets below (and the operator
# uses the same grant to seed the source-URL secret out of band).
resource "azurerm_role_assignment" "deployer_secrets" {
  count = var.grant_deployer_secrets_officer ? 1 : 0

  scope                = local.vault_id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# The engine host: reads the token + source URL, writes dbname and the
# runtime namespaces (snapshots/*, schema/*, …). Key Vault RBAC cannot scope
# to secret-name patterns, so Officer on the vault is the tightest grant.
resource "azurerm_role_assignment" "vm_secrets" {
  scope                = local.vault_id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = azurerm_linux_virtual_machine.this.identity[0].principal_id
  principal_type       = "ServicePrincipal" # fresh MSI — skip the AAD replication check
}

# ---------------------------------------------------------------------------
# Discovery for the CLI/CI: secrets vanish with this module — the absence of
# instance-id is the "platform is down, nothing to delete" signal.
# ---------------------------------------------------------------------------

# The CLI hands this to `az network bastion tunnel --target-resource-id`.
resource "azurerm_key_vault_secret" "instance_id" {
  name         = "${local.secret_prefix}-instance-id"
  key_vault_id = local.vault_id
  value        = azurerm_linux_virtual_machine.this.id
  content_type = "text/plain"
  tags         = var.tags

  depends_on = [azurerm_role_assignment.deployer_secrets]
}

resource "azurerm_key_vault_secret" "host" {
  name         = "${local.secret_prefix}-host"
  key_vault_id = local.vault_id
  value        = azurerm_network_interface.this.private_ip_address
  content_type = "text/plain"
  tags         = var.tags

  depends_on = [azurerm_role_assignment.deployer_secrets]
}

# Written by the host at boot (it learns the db name by parsing the source
# URL). Key Vault versions are additive — the host's REST PUT adds a version;
# Terraform owns the lifecycle so `destroy` cleans it up, and ignores the
# drifting value.
resource "azurerm_key_vault_secret" "dbname" {
  name         = "${local.secret_prefix}-dbname"
  key_vault_id = local.vault_id
  value        = "unknown"
  content_type = "text/plain"
  tags         = var.tags

  lifecycle {
    ignore_changes = [value]
  }

  depends_on = [azurerm_role_assignment.deployer_secrets]
}

# Capacity readout for `tendb status` (clone cap = port-pool width).
resource "azurerm_key_vault_secret" "port_pool" {
  name         = "${local.secret_prefix}-port-pool"
  key_vault_id = local.vault_id
  value        = "${local.port_from}-${local.port_to}"
  content_type = "text/plain"
  tags         = var.tags

  depends_on = [azurerm_role_assignment.deployer_secrets]
}

# azure-only contract param: the CLI parses name + resource group out of the
# Bastion resource id to spawn its tunnels.
resource "azurerm_key_vault_secret" "bastion_id" {
  name         = "${local.secret_prefix}-bastion-id"
  key_vault_id = local.vault_id
  value        = local.bastion_host_id
  content_type = "text/plain"
  tags         = var.tags

  depends_on = [azurerm_role_assignment.deployer_secrets]
}
