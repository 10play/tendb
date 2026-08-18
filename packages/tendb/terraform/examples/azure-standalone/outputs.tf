# Drop into tendb.json next to your project (or set the matching TENDB_* env
# vars) — everything else the CLI discovers from the vault.
output "cli_discovery" {
  value = jsonencode({
    platform    = "azure"
    paramPrefix = module.engine.param_prefix
    azureVault  = module.engine.key_vault_name
  })
}

output "key_vault_name" {
  value = module.engine.key_vault_name
}

output "engine_vm_id" {
  value = module.engine.vm_id
}

output "engine_private_ip" {
  value = module.engine.private_ip
}

output "bastion_host_id" {
  value = module.engine.bastion_host_id
}

output "client_role_snippet" {
  description = "Role assignments each CLI/CI principal needs."
  value       = module.engine.client_role_snippet
}

output "console_url" {
  value = var.enable_console ? module.console[0].url : null
}

output "console_required_dns_record" {
  value = var.enable_console ? module.console[0].required_dns_record : null
}
