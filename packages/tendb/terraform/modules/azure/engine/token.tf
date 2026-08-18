# API verification token. Generated ephemerally and written with a write-only
# argument, so the token never enters Terraform state (azurerm >= 4.23).
#
# Rotation: bump var.token_secret_version. CAUTION: clone passwords are
# sha256(token:clone) — rotate only when running clones are disposable.
ephemeral "random_password" "token" {
  length  = 32
  special = false
}

resource "azurerm_key_vault_secret" "token" {
  name             = "${local.secret_prefix}-verification-token"
  key_vault_id     = local.vault_id
  value_wo         = ephemeral.random_password.token.result
  value_wo_version = var.token_secret_version
  content_type     = "text/plain"
  tags             = var.tags

  depends_on = [azurerm_role_assignment.deployer_secrets]
}
