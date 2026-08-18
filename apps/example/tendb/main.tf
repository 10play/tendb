# Local tendb: DBLab + snapshotd (+ optional demo source) on a ZFS-capable
# docker host. Scaffolded by `tendb init`; `tendb up` runs the preflight
# (scripts/host-setup.sh — colima VM + zpool) and terraform for you.
#
# Docker Desktop will NOT work on macOS (its LinuxKit kernel has no ZFS) —
# the preflight builds a colima VM instead. For the dashboard use the CLI's
# own `tendb console` / `tendb ui`.

terraform {
  required_version = ">= 1.11"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}

# Honors DOCKER_HOST when set (`tendb up` points it at the colima socket).
provider "docker" {}

variable "name" {
  type    = string
  default = "tendb"
}

variable "state_dir" {
  description = "Host dir for params.json + engine config (must be under a VM-mounted path)."
  type        = string
  default     = null
}

variable "size" {
  type    = string
  default = "small"
}

variable "source_url" {
  description = "Source Postgres URL as reachable from the docker host. Leave null to provision the demo source container."
  type        = string
  sensitive   = true
  default     = null
}

variable "demo_source_port" {
  description = "Host port for the demo source (dialed by DBLab via the docker bridge gateway)."
  type        = number
  default     = 5455
}

variable "postgres_major_version" {
  type    = string
  default = "16"
}

locals {
  state_dir = coalesce(var.state_dir, pathexpand("~/.tendb/local"))
  # Sibling containers reach published host ports via the docker bridge gw.
  demo_source_url = "postgres://postgres:postgres@172.17.0.1:${var.demo_source_port}/appdb"
  source_url      = coalesce(var.source_url, local.demo_source_url)
}

# Demo "customer production DB" — so branches have something worth branching.
resource "docker_image" "source" {
  count = var.source_url == null ? 1 : 0
  name  = "postgres:${var.postgres_major_version}"
}

resource "docker_container" "source" {
  count   = var.source_url == null ? 1 : 0
  name    = "${var.name}_demo_source"
  image   = docker_image.source[0].image_id
  restart = "unless-stopped"

  env = [
    "POSTGRES_PASSWORD=postgres",
    "POSTGRES_DB=appdb",
  ]

  ports {
    internal = 5432
    external = var.demo_source_port
  }

  upload {
    file    = "/docker-entrypoint-initdb.d/seed.sql"
    content = file("${path.module}/seed/seed.sql")
  }
}

module "engine" {
  source = "../../../packages/tendb/terraform/modules/local/engine"

  name                   = var.name
  state_dir              = local.state_dir
  size                   = var.size
  source_url             = local.source_url
  postgres_major_version = var.postgres_major_version

  depends_on = [docker_container.source]
}

output "cli_discovery" {
  value = module.engine.cli_discovery
}

output "params_path" {
  value = module.engine.params_path
}
