# Local console: `tendb console` in a node container on the docker host's
# network namespace (so 127.0.0.1:2345 reaches the engine's published port).
# Loopback-only IS the auth model here — no Caddy, no oauth2-proxy; the
# hosted-console stack stays a cloud concern. Functional parity, not
# auth-stack parity (documented in README.md).

terraform {
  required_version = ">= 1.11"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}

variable "name" {
  type    = string
  default = "tendb"
}

variable "state_dir" {
  description = "Same state dir the engine module writes (params.json)."
  type        = string
}

variable "repo_root" {
  description = "Monorepo root bind-mounted into the container — pnpm's node_modules symlinks resolve relative to it; the CLI must be built (pnpm build)."
  type        = string
}

variable "port" {
  description = "Console port on the docker host loopback (lima forwards it to the mac)."
  type        = number
  default     = 4400
}

resource "docker_image" "node" {
  name = "node:22-slim"
}

resource "docker_container" "console" {
  name         = "${var.name}_console"
  image        = docker_image.node.image_id
  restart      = "unless-stopped"
  network_mode = "host"

  command = [
    "node",
    "/repo/packages/tendb/cli/dist/index.js",
    "console",
    "--no-open",
    "--port",
    tostring(var.port),
  ]

  env = [
    "TENDB_PLATFORM=local",
    "TENDB_STATE_DIR=/state",
    "TENDB_CONFIG=",
  ]

  volumes {
    host_path      = var.repo_root
    container_path = "/repo"
  }
  volumes {
    host_path      = var.state_dir
    container_path = "/state"
  }
}

output "url" {
  value = "http://127.0.0.1:${var.port}"
}
