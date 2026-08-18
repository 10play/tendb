# Greenfield GCP deployment: minimal network + engine (+ optional console)
# in a fresh project.
#
# The source secret is created OUT of band (the URL must never land in TF
# state):
#   printf '%s' 'postgres://user:pass@host:5432/dbname' | \
#     gcloud secrets create tendb-source-url --data-file=-

terraform {
  required_version = ">= 1.11"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.25"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

provider "google" {
  project = var.project
  region  = var.region

  default_labels = {
    project    = var.name
    managed-by = "terraform"
  }
}

module "network" {
  source = "../../modules/gcp/network"

  name   = var.name
  region = var.region
  mode   = var.network_mode
}

module "engine" {
  source = "../../modules/gcp/engine"

  name               = var.name
  project            = var.project
  zone               = var.zone
  network_self_link  = module.network.network_self_link
  subnet_self_link   = module.network.subnet_self_link
  assign_external_ip = module.network.assign_external_ip
  client_cidr_ranges = [module.network.cidr] # in-VPC clients; the CLI tunnels via IAP regardless

  size                    = var.size
  postgres_major_version  = var.postgres_major_version
  source_secret_id        = var.source_secret_id
  source_secret_json_key  = var.source_secret_json_key
  dump_exclude_extensions = var.dump_exclude_extensions
  streaming_snapshots     = var.streaming_snapshots
  sync_target_port        = var.sync_target_port
}

# Optional hosted console: https://<console_domain>, Google login restricted
# to console_allowed_email_domains. Prereqs (see modules/gcp/console/README.md):
# a Google OAuth client in Secret Manager, a domain, and a packed CLI tarball
# or npm spec.
module "console" {
  count  = var.enable_console ? 1 : 0
  source = "../../modules/gcp/console"

  name              = "${var.name}-console"
  project           = var.project
  zone              = var.zone
  network_self_link = module.network.network_self_link
  subnet_self_link  = module.network.subnet_self_link

  domain                = var.console_domain
  managed_zone          = var.console_managed_zone
  acme_email            = var.console_acme_email
  allowed_email_domains = var.console_allowed_email_domains
  oauth_secret_id       = var.console_oauth_secret_id
  package_tarball_path  = var.console_package_tarball_path
  npm_package_spec      = var.console_npm_package_spec

  engine_param_prefix = module.engine.param_prefix

  # Per-secret IAM binds to secrets the engine module creates.
  depends_on = [module.engine]
}
