terraform {
  # >= 1.11: write-only arguments (value_wo) keep the API token out of state.
  required_version = ">= 1.11"

  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
      # 4.23 introduced value_wo/value_wo_version on azurerm_key_vault_secret.
      version = "~> 4.23"
    }
    random = {
      source = "hashicorp/random"
      # 3.7 introduced the ephemeral random_password resource.
      version = "~> 3.7"
    }
  }
}
