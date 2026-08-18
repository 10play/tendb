locals {
  nat = var.mode == "nat"
}

resource "azurerm_virtual_network" "this" {
  name                = var.name
  address_space       = [var.cidr]
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

# The name is mandated by Azure verbatim, and /26 is the documented minimum.
resource "azurerm_subnet" "bastion" {
  name                 = "AzureBastionSubnet"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet(var.cidr, 10, 0)] # 10.60.0.0/26 at the default cidr
}

resource "azurerm_subnet" "engine" {
  name                 = "${var.name}-engine"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet(var.cidr, 8, 1)] # 10.60.1.0/24 at the default cidr

  # Explicit, because Azure flips the platform default for subnets created
  # after 2025-09-30 (default outbound access retirement).
  default_outbound_access_enabled = !local.nat
}

resource "azurerm_public_ip" "nat" {
  count = local.nat ? 1 : 0

  name                = "${var.name}-nat"
  location            = var.location
  resource_group_name = var.resource_group_name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway" "this" {
  count = local.nat ? 1 : 0

  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku_name            = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway_public_ip_association" "this" {
  count = local.nat ? 1 : 0

  nat_gateway_id       = azurerm_nat_gateway.this[0].id
  public_ip_address_id = azurerm_public_ip.nat[0].id
}

resource "azurerm_subnet_nat_gateway_association" "engine" {
  count = local.nat ? 1 : 0

  subnet_id      = azurerm_subnet.engine.id
  nat_gateway_id = azurerm_nat_gateway.this[0].id
}
