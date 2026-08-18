# Greenfield deployment: resource group + minimal network + engine (and
# optionally the hosted console) in a fresh Azure subscription.
#
# The source secret is created OUT of band (the URL must never land in TF
# state) — and it lives in the vault this stack creates, so a first-ever
# apply is two-phase:
#
#   terraform apply -target=module.engine.azurerm_key_vault.this \
#                   -target=module.engine.azurerm_role_assignment.deployer_secrets
#   az keyvault secret set --vault-name <vault> --name tendb-source-url \
#     --value 'postgres://user:pass@host:5432/dbname'
#   terraform apply

terraform {
  required_version = ">= 1.11"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.23"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

provider "azurerm" {
  features {}
  # azurerm 4.x requires a subscription: set var.subscription_id or
  # ARM_SUBSCRIPTION_ID.
  subscription_id = var.subscription_id
}

resource "azurerm_resource_group" "this" {
  name     = var.name
  location = var.location
  tags     = { project = var.name, managed-by = "terraform" }
}

module "network" {
  source = "../../modules/azure/network"

  name                = var.name
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  mode                = var.network_mode
}

module "engine" {
  source = "../../modules/azure/engine"

  name                = var.name
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  subnet_id           = module.network.engine_subnet_id
  bastion_subnet_id   = module.network.bastion_subnet_id
  bastion_subnet_cidr = module.network.bastion_subnet_cidr
  client_cidrs        = [module.network.cidr] # in-VNet clients; the CLI tunnels via Bastion regardless

  admin_ssh_public_key = var.admin_ssh_public_key

  size                    = var.size
  postgres_major_version  = var.postgres_major_version
  source_secret_name      = var.source_secret_name
  source_secret_json_key  = var.source_secret_json_key
  dump_exclude_extensions = var.dump_exclude_extensions
  streaming_snapshots     = var.streaming_snapshots
}

# Optional hosted console: https://<console_domain>, Google login restricted
# to allowed_email_domains. Prereqs (see modules/azure/console/README.md): a
# Google OAuth client secret in the engine vault, a domain, and a packed CLI
# tarball or npm spec.
module "console" {
  count  = var.enable_console ? 1 : 0
  source = "../../modules/azure/console"

  name                = "${var.name}-console"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  subnet_id           = module.network.engine_subnet_id

  admin_ssh_public_key = var.admin_ssh_public_key

  domain                = var.console_domain
  acme_email            = var.acme_email
  oauth_secret_name     = var.oauth_secret_name
  allowed_email_domains = var.allowed_email_domains
  package_tarball_path  = var.package_tarball_path
  npm_package_spec      = var.npm_package_spec

  key_vault_id        = module.engine.key_vault_id
  engine_param_prefix = module.engine.param_prefix
}
