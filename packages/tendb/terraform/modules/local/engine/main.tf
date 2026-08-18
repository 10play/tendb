# Local platform engine: the same DBLab server the cloud platforms run, as a
# container on a ZFS-capable docker host. terraform drives everything from
# the Docker API down; the VM, the zfs module, and the file-backed zpool are
# the preflight's job (scripts/host-setup.sh) — terraform cannot load kernel
# modules. See ../../../docs/ENGINE-CONTRACT.md.

terraform {
  required_version = ">= 1.11"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

module "presets" {
  source = "../../common/presets"
  size   = var.size
}

locals {
  param_prefix = coalesce(var.param_prefix, "/${var.name}")
  clone_image  = coalesce(var.clone_image, "postgresai/extended-postgres:${var.postgres_major_version}-0.8.0")
  container    = "${var.name}_dblab_server"

  # Everything the URL parse does at boot on cloud platforms, terraform does
  # here — local mode has no boot-time writer (dev-machine state is accepted).
  # Terraform has no urldecode: credentials must be literal (percent-encoded
  # passwords are a cloud-platform luxury; local sources are dev databases).
  source_parts = regex("^postgres(?:ql)?://(?:(?<user>[^:@/]+)(?::(?<pass>[^@/]*))?@)?(?<host>[^:/?]+)(?::(?<port>\\d+))?/(?<db>[^?]+)", var.source_url)
  db_user      = coalesce(local.source_parts.user, "postgres")
  db_pass      = coalesce(local.source_parts.pass, " ") == " " ? "" : local.source_parts.pass
  db_host      = local.source_parts.host
  db_port      = coalesce(local.source_parts.port, "5432")
  db_name      = local.source_parts.db

  postgres_configs = merge(
    module.presets.postgres_configs,
    { shared_preload_libraries = "pg_stat_statements" },
  )

  server_yml = templatefile("${path.module}/../../common/engine-init/templates/server-yml.tpl", {
    token                 = random_password.token.result
    ui_enabled            = var.ui_enabled
    ui_image              = var.ui_image
    ui_host               = "127.0.0.1"
    clone_image           = local.clone_image
    shm_size              = module.presets.shm_size
    streaming_snapshots   = var.streaming_snapshots
    postgres_configs      = local.postgres_configs
    port_pool_from        = module.presets.port_from
    port_pool_to          = module.presets.port_to
    refresh_cron          = var.refresh_cron
    skip_start_refresh    = var.skip_start_refresh
    dump_parallel_jobs    = module.presets.dump_parallel_jobs
    restore_parallel_jobs = module.presets.restore_parallel_jobs
    exclude_extensions    = var.dump_exclude_extensions
    max_idle_minutes      = var.max_idle_minutes
    logs_retention_days   = var.logs_retention_days
    access_host           = "127.0.0.1"
    db_name               = local.db_name
    db_host               = local.db_host
    db_port               = local.db_port
    db_user               = local.db_user
    db_pass               = local.db_pass
  })
}

# Local-only concession: the token lives in dev-machine state (no write-only
# secret store to hide it in). Keep the example dir and state_dir at 0700.
resource "random_password" "token" {
  length  = 32
  special = false
}

resource "local_sensitive_file" "server_yml" {
  filename        = "${var.state_dir}/engine/configs/server.yml"
  content         = local.server_yml
  file_permission = "0600"
}

resource "docker_image" "server" {
  name = var.server_image
}

resource "docker_image" "clone" {
  name = local.clone_image
}

resource "docker_container" "dblab_server" {
  name       = local.container
  image      = docker_image.server.image_id
  privileged = true
  restart    = "unless-stopped"

  # DBLab spawns clone and embedded-UI containers itself over this socket;
  # their ports (6000+, 2346) are published by DBLab — publishing 2346 here
  # too would squat the UI container's bind. lima/colima forwards published
  # ports to the host.
  ports {
    internal = 2345
    external = 2345
    ip       = "127.0.0.1"
  }

  volumes {
    host_path      = "/var/run/docker.sock"
    container_path = "/var/run/docker.sock"
  }
  volumes {
    host_path      = dirname(local_sensitive_file.server_yml.filename)
    container_path = "/home/dblab/configs"
  }
  # Branch/clone metadata must survive container replacement.
  volumes {
    host_path      = "${var.state_dir}/engine/meta"
    container_path = "/home/dblab/meta"
  }
  volumes {
    host_path      = "${var.state_dir}/engine/logs"
    container_path = "/home/dblab/logs"
  }

  # The ZFS pool mount must propagate into clone containers.
  mounts {
    target = var.dblab_dir
    source = var.dblab_dir
    type   = "bind"
    bind_options {
      propagation = "rshared"
    }
  }

  depends_on = [docker_image.clone]
}
