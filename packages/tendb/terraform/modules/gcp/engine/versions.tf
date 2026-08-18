terraform {
  # >= 1.11: write-only arguments (secret_data_wo) keep the API token out of state.
  required_version = ">= 1.11"

  required_providers {
    google = {
      source = "hashicorp/google"
      # >= 6.25: secret_data_wo on google_secret_manager_secret_version.
      version = ">= 6.25, < 8.0"
    }
    random = {
      source = "hashicorp/random"
      # >= 3.7: ephemeral random_password.
      version = ">= 3.7"
    }
  }
}
