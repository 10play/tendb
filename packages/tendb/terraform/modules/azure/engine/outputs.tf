output "vm_id" {
  description = "The VM's ARM resource id (also published as the instance-id contract param)."
  value       = azurerm_linux_virtual_machine.this.id
}

output "private_ip" {
  value = azurerm_network_interface.this.private_ip_address
}

output "principal_id" {
  description = "The VM's system-assigned identity. Attach extra role assignments here (e.g. more vaults for future sync sources)."
  value       = azurerm_linux_virtual_machine.this.identity[0].principal_id
}

output "network_interface_id" {
  value = azurerm_network_interface.this.id
}

output "network_security_group_id" {
  value = azurerm_network_security_group.this.id
}

output "key_vault_id" {
  value = local.vault_id
}

output "key_vault_name" {
  description = "The CLI's `azureVault` config field."
  value       = local.vault_name
}

output "param_prefix" {
  value = local.param_prefix
}

output "secret_names" {
  description = "The tendb CLI's discovery contract, mapped onto Key Vault names."
  value = {
    instance_id        = azurerm_key_vault_secret.instance_id.name
    host               = azurerm_key_vault_secret.host.name
    verification_token = azurerm_key_vault_secret.token.name
    dbname             = azurerm_key_vault_secret.dbname.name
    port_pool          = azurerm_key_vault_secret.port_pool.name
    bastion_id         = azurerm_key_vault_secret.bastion_id.name
  }
}

output "api_port" {
  value = 2345
}

output "clone_port_range" {
  value = { from = local.port_from, to = local.port_to }
}

output "bastion_host_id" {
  value = local.bastion_host_id
}

# Key Vault RBAC has no per-secret scoping and Azure has no tag-conditioned
# equivalent of the AWS client policy document, so this is a runbook string
# rather than an attachable policy.
output "client_role_snippet" {
  description = "Role assignments a CLI/CI principal needs (Reader covers the Bastion tunnel's resource lookups; Secrets User covers discovery + token reads)."
  value       = <<-EOT
    # Replace <CLIENT_OBJECT_ID> with the operator/CI principal's object id.
    az role assignment create --assignee <CLIENT_OBJECT_ID> --role "Reader" --scope ${azurerm_linux_virtual_machine.this.id}
    az role assignment create --assignee <CLIENT_OBJECT_ID> --role "Reader" --scope ${azurerm_network_interface.this.id}
    az role assignment create --assignee <CLIENT_OBJECT_ID> --role "Reader" --scope ${local.bastion_host_id}
    az role assignment create --assignee <CLIENT_OBJECT_ID> --role "Key Vault Secrets User" --scope ${local.vault_id}
    # Operators who trigger snapshots / schema syncs write request nonces:
    az role assignment create --assignee <CLIENT_OBJECT_ID> --role "Key Vault Secrets Officer" --scope ${local.vault_id}
  EOT
}
