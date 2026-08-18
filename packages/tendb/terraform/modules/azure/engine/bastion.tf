# Azure Bastion is the CLI's tunnel transport (`az network bastion tunnel`
# replaces AWS SSM port-forwards) and the only admin path (`az network
# bastion ssh`). Native-client tunneling needs the Standard SKU — which idles
# at ~$140/mo, by far this platform's biggest fixed cost. One Bastion serves
# a whole VNet: share it across workloads where possible
# (create_bastion = false + bastion_host_id).

resource "azurerm_public_ip" "bastion" {
  count = var.create_bastion ? 1 : 0

  name                = "${var.name}-bastion"
  location            = var.location
  resource_group_name = var.resource_group_name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_bastion_host" "this" {
  count = var.create_bastion ? 1 : 0

  name                = "${var.name}-bastion"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "Standard"
  tunneling_enabled   = true
  tags                = var.tags

  ip_configuration {
    name                 = "config"
    subnet_id            = var.bastion_subnet_id
    public_ip_address_id = azurerm_public_ip.bastion[0].id
  }
}
