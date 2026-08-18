# DBLab Engine host (postgres.ai) — ZFS thin clones of a source Postgres
# database. Private-first: no SSH keys in metadata; admin + API access ride
# IAP tunnels (clients need roles/iap.tunnelResourceAccessor), direct TCP is
# for declared in-VPC clients only.

# Ubuntu: ZFS is one `apt-get install zfsutils-linux`.
data "google_compute_image" "ubuntu_2404" {
  family  = "ubuntu-2404-lts-amd64"
  project = "ubuntu-os-cloud"
}

# ZFS pool device — thin clones + the logical dump live here.
resource "google_compute_disk" "data" {
  name   = "${var.name}-data"
  zone   = var.zone
  type   = "pd-ssd"
  size   = local.data_volume_gb
  labels = var.labels
}

locals {
  init_templates = "${path.module}/../../common/engine-init/templates"
  snapshotd_dir  = "${path.module}/../../../../snapshotd"

  # Runtime values stay SHELL variables ("$TOKEN"…): init-core writes
  # server.yml through an unquoted heredoc, so the host expands them at boot
  # — credentials never transit Terraform values or instance metadata.
  server_yml = templatefile("${local.init_templates}/server-yml.tpl", {
    token                 = "$TOKEN"
    db_name               = "$DB_NAME"
    db_host               = "$DB_HOST"
    db_port               = "$DB_PORT"
    db_user               = "$DB_USER"
    db_pass               = "$DB_PASS"
    access_host           = "$PRIVATE_IP"
    ui_enabled            = var.ui_enabled
    ui_host               = "$PRIVATE_IP"
    ui_image              = var.ui_image
    clone_image           = local.clone_image
    shm_size              = local.shm_size
    streaming_snapshots   = var.streaming_snapshots
    postgres_configs      = local.postgres_configs
    port_pool_from        = local.port_from
    port_pool_to          = local.port_to
    refresh_cron          = var.refresh_cron
    skip_start_refresh    = var.skip_start_refresh
    exclude_extensions    = var.dump_exclude_extensions
    dump_parallel_jobs    = local.dump_parallel_jobs
    restore_parallel_jobs = local.restore_parallel_jobs
    max_idle_minutes      = var.clone_max_idle_minutes
    logs_retention_days   = var.logs_retention_days
  })

  shim = templatefile("${path.module}/templates/shim.sh.tpl", {
    param_prefix     = local.param_prefix
    data_device_name = local.data_device_name
    shim_body        = file("${local.snapshotd_dir}/shims/gcp.sh")
  })

  init_core = templatefile("${local.init_templates}/init-core.sh.tpl", {
    server_yml             = local.server_yml
    source_secret_id       = var.source_secret_id
    source_secret_json_key = var.source_secret_json_key == null ? "" : var.source_secret_json_key
    server_image           = var.server_image
    param_prefix           = local.param_prefix
    shim_script_b64        = base64encode(file("${local.snapshotd_dir}/shims/gcp.sh"))
    snapshotd_script_b64   = base64encode(file("${local.snapshotd_dir}/tendb-snapshotd.sh"))
    snapshotd_unit_b64     = base64encode(file("${local.snapshotd_dir}/tendb-snapshotd.service"))
  })

  startup_script = join("\n", ["#!/usr/bin/env bash", local.shim, local.init_core])
}

resource "google_compute_instance" "this" {
  name         = var.name
  zone         = var.zone
  machine_type = local.machine_type
  tags         = [local.network_tag] # firewall rules key off this
  labels       = var.labels

  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image  = data.google_compute_image.ubuntu_2404.self_link
      size   = local.root_volume_gb
      type   = "pd-balanced"
      labels = var.labels
    }
  }

  attached_disk {
    source      = google_compute_disk.data.id
    device_name = local.data_device_name # pf_data_device resolves /dev/disk/by-id/google-<this>
  }

  network_interface {
    subnetwork = var.subnet_self_link

    dynamic "access_config" {
      for_each = var.assign_external_ip ? [1] : []
      content {} # ephemeral external IP — egress only; ingress is firewall-gated
    }
  }

  service_account {
    email  = google_service_account.engine.email
    scopes = ["cloud-platform"] # per-secret IAM is the real boundary
  }

  # CAUTION: any startup-script change REPLACES the instance (the provider
  # forces new) — every clone dies and the data re-syncs from the source at
  # boot. Grep every plan for "must be replaced" before applying.
  metadata_startup_script = local.startup_script

  # Boot reads the token + source URL and version-adds dbname with no retry —
  # the token version and every grant must exist before first boot.
  depends_on = [
    google_secret_manager_secret_version.token,
    google_secret_manager_secret_iam_member.engine_accessor,
    google_secret_manager_secret_iam_member.engine_token_accessor,
    google_secret_manager_secret_iam_member.engine_dbname_adder,
    google_secret_manager_secret_iam_member.engine_source,
  ]
}

# ---------------------------------------------------------------------------
# Discovery for the CLI/CI, mapped per the contract ("/tendb/a/b" →
# "tendb_a_b"). Secrets vanish with this module — the absence of instance-id
# is the "platform is down, nothing to delete" signal. Runtime namespaces are
# created empty (secret, no version): reads report absent, writers only need
# secretVersionAdder.
# ---------------------------------------------------------------------------

resource "google_secret_manager_secret" "params" {
  for_each  = local.param_secret_ids
  secret_id = each.value
  labels    = var.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "instance_id" {
  secret = google_secret_manager_secret.params["instance-id"].id
  # This exact format is the CLI's tunnel target — its gcp adapter parses it.
  secret_data = "projects/${local.project}/zones/${var.zone}/instances/${google_compute_instance.this.name}"
}

resource "google_secret_manager_secret_version" "host" {
  secret      = google_secret_manager_secret.params["host"].id
  secret_data = google_compute_instance.this.network_interface[0].network_ip
}

# Placeholder only: the host parses the source URL at boot and version-adds
# the real name (versions are separate resources — Terraform owns just this
# initial one, so there is no ownership conflict).
resource "google_secret_manager_secret_version" "dbname" {
  secret      = google_secret_manager_secret.params["dbname"].id
  secret_data = "unknown"
}

# Capacity readout for `tendb status` (clone cap = port-pool width).
resource "google_secret_manager_secret_version" "port_pool" {
  secret      = google_secret_manager_secret.params["port-pool"].id
  secret_data = "${local.port_from}-${local.port_to}"
}
