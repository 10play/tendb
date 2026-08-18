# tendb on GCP: minimal network + engine in a fresh project. Scaffolded by
# `tendb init` — edit freely. Module sources are pinned; bump the ?ref=
# consciously (init template changes REPLACE the host and destroy all branches).
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
  source = "@tendb-modules/gcp/network"

  name   = var.name
  region = var.region
  mode   = var.network_mode
}

module "engine" {
  source = "@tendb-modules/gcp/engine"

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
