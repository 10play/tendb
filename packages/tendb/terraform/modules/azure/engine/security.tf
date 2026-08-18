# No public ingress: the NIC has no public IP and the rules below admit only
# the declared client CIDRs plus the Bastion subnet (Bastion dials the VM
# in-VNet). The custom deny at 4000 overrides Azure's default
# AllowVnetInBound, which would otherwise open every port to the VNet.

resource "azurerm_network_security_group" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_network_interface_security_group_association" "this" {
  network_interface_id      = azurerm_network_interface.this.id
  network_security_group_id = azurerm_network_security_group.this.id
}

resource "azurerm_network_security_rule" "client_api" {
  count = length(var.client_cidrs) > 0 ? 1 : 0

  name                        = "client-dblab-api"
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "2345"
  source_address_prefixes     = var.client_cidrs
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.this.name
}

resource "azurerm_network_security_rule" "client_clones" {
  count = length(var.client_cidrs) > 0 ? 1 : 0

  name                        = "client-clone-postgres"
  priority                    = 110
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "${local.port_from}-${local.port_to}"
  source_address_prefixes     = var.client_cidrs
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.this.name
}

# Streaming-source setups run a sync-target Postgres on the host that the
# hosted console probes in-VNet.
resource "azurerm_network_security_rule" "client_sync_target" {
  count = var.sync_target_port != null && length(var.client_cidrs) > 0 ? 1 : 0

  name                        = "client-sync-target"
  priority                    = 120
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = tostring(var.sync_target_port)
  source_address_prefixes     = var.client_cidrs
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.this.name
}

# Bastion terminates the CLI's tunnels and dials the VM from its own subnet —
# every port a tunnel may target, plus 22 for `az network bastion ssh`.
resource "azurerm_network_security_rule" "bastion" {
  name              = "bastion-tunnels"
  priority          = 130
  direction         = "Inbound"
  access            = "Allow"
  protocol          = "Tcp"
  source_port_range = "*"
  destination_port_ranges = concat(
    ["22", "2345", "2346", "${local.port_from}-${local.port_to}"],
    var.sync_target_port != null ? [tostring(var.sync_target_port)] : [],
  )
  source_address_prefix       = var.bastion_subnet_cidr
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.this.name
}

# Co-hosted console (Caddy terminates TLS on this host). NSG-rule-only —
# flipping console_ingress never touches custom_data or the VM.
resource "azurerm_network_security_rule" "console" {
  count = var.console_ingress ? 1 : 0

  name                        = "console-http-https"
  priority                    = 140
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_ranges     = ["80", "443"]
  source_address_prefix       = "Internet"
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.this.name
}

# Keep platform health probes working past the deny below.
resource "azurerm_network_security_rule" "allow_lb" {
  name                        = "allow-azure-lb"
  priority                    = 3900
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "*"
  source_address_prefix       = "AzureLoadBalancer"
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.this.name
}

resource "azurerm_network_security_rule" "deny_all" {
  name                        = "deny-all-inbound"
  priority                    = 4000
  direction                   = "Inbound"
  access                      = "Deny"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "*"
  source_address_prefix       = "*"
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.this.name
}
