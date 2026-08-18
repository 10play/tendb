output "vnet_id" {
  value = azurerm_virtual_network.this.id
}

output "cidr" {
  value = var.cidr
}

output "engine_subnet_id" {
  value = azurerm_subnet.engine.id
}

output "bastion_subnet_id" {
  description = "The AzureBastionSubnet — wire into the engine module's bastion_subnet_id."
  value       = azurerm_subnet.bastion.id
}

output "bastion_subnet_cidr" {
  description = "Wire into the engine module's bastion_subnet_cidr (NSG source for Bastion-dialed traffic)."
  value       = azurerm_subnet.bastion.address_prefixes[0]
}
