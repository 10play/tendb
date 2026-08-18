# tendb-snapshotd as a privileged sibling container: same zfs pool, same
# docker socket (to restart the engine after a snapshot), params.json via the
# shared state dir. Built from packages/tendb/snapshotd.

locals {
  snapshotd_context = coalesce(var.snapshotd_context, "${path.module}/../../../../snapshotd")
}

resource "docker_image" "snapshotd" {
  name = "${var.name}-snapshotd:local"

  build {
    context = local.snapshotd_context
  }

  triggers = {
    script = filesha256("${local.snapshotd_context}/tendb-snapshotd.sh")
    shim   = filesha256("${local.snapshotd_context}/shims/local.sh")
    docker = filesha256("${local.snapshotd_context}/Dockerfile")
  }
}

resource "docker_container" "snapshotd" {
  name       = "${var.name}_snapshotd"
  image      = docker_image.snapshotd.image_id
  privileged = true
  restart    = "unless-stopped"

  env = [
    "TENDB_PARAM_PREFIX=${local.param_prefix}",
    "TENDB_ENGINE_CONTAINER=${local.container}",
    "TENDB_PARAMS_FILE=/state/params.json",
  ]

  volumes {
    host_path      = "/var/run/docker.sock"
    container_path = "/var/run/docker.sock"
  }
  volumes {
    host_path      = var.dblab_dir
    container_path = var.dblab_dir
  }
  volumes {
    host_path      = var.state_dir
    container_path = "/state"
  }
  # zfs userspace in the container drives the VM's kernel module.
  devices {
    host_path      = "/dev/zfs"
    container_path = "/dev/zfs"
  }

  depends_on = [local_sensitive_file.params, docker_container.dblab_server]
}
