# Deployed tendb console: the same server `tendb console` runs locally,
# hosted in-VPC next to the engine (direct TCP — no tunnels), behind
# oauth2-proxy (Google, domain-restricted) and Caddy (automatic HTTPS).
#
# Request path:  browser → :443 Caddy → :4180 oauth2-proxy → :4400 console
# The console itself binds loopback only; the token and clone credentials
# never reach the browser.

data "google_client_config" "current" {}

data "google_compute_image" "ubuntu_2404" {
  family  = "ubuntu-2404-lts-amd64"
  project = "ubuntu-os-cloud"
}

locals {
  project = coalesce(var.project, data.google_client_config.current.project)
  region  = join("-", slice(split("-", var.zone), 0, 2)) # us-central1-a → us-central1

  # Same contract mapping as the engine module: "/tendb/a/b" → "tendb_a_b".
  contract_keys = [
    "instance-id",
    "host",
    "verification-token",
    "dbname",
    "port-pool",
    "snapshots/config",
    "snapshots/request",
    "schema/config",
    "schema/sync-request",
    "alerts/slack-webhook",
    "console-url",
    "replication/publisher-url",
    "replication/subscriber-url",
  ]
  # The console writes the snapshot schedule + on-demand requests, the Slack
  # alert webhook, and schema-sync requests/config (the engine host's
  # executor reads them).
  write_keys = ["snapshots/config", "snapshots/request", "alerts/slack-webhook", "schema/config", "schema/sync-request"]

  engine_secret_ids = {
    for k in local.contract_keys :
    k => replace(trimprefix("${var.engine_param_prefix}/${k}", "/"), "/", "_")
  }
}

# ---------------------------------------------------------------------------
# Package delivery: local tarball → private GCS object the host pulls at boot.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "pkg" {
  count = var.package_tarball_path != null ? 1 : 0

  name                        = "${var.name}-pkg-${local.project}"
  location                    = "US"
  force_destroy               = true
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = var.labels
}

resource "google_storage_bucket_object" "pkg" {
  count = var.package_tarball_path != null ? 1 : 0

  bucket = google_storage_bucket.pkg[0].name
  name   = "tendb.tgz"
  source = var.package_tarball_path
  # md5Hash change is the on-host updater's release signal.
}

# ---------------------------------------------------------------------------
# Identity / IAM — per-secret grants only, like the engine module.
# ---------------------------------------------------------------------------

resource "google_service_account" "this" {
  account_id   = var.name
  display_name = "${var.name} host"
}

# Engine discovery + runtime config. The secrets are created by the engine
# module — apply it first.
resource "google_secret_manager_secret_iam_member" "engine_read" {
  for_each  = local.engine_secret_ids
  project   = local.project
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.this.email}"
}

resource "google_secret_manager_secret_iam_member" "engine_write" {
  for_each  = { for k in local.write_keys : k => local.engine_secret_ids[k] }
  project   = local.project
  secret_id = each.value
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.this.email}"
}

resource "google_secret_manager_secret_iam_member" "oauth" {
  project   = local.project
  secret_id = var.oauth_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.this.email}"
}

resource "google_storage_bucket_iam_member" "pkg" {
  count = var.package_tarball_path != null ? 1 : 0

  bucket = google_storage_bucket.pkg[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.this.email}"
}

# ---------------------------------------------------------------------------
# Network: public HTTPS (auth handled by oauth2-proxy), admin over IAP only.
# ---------------------------------------------------------------------------

resource "google_compute_firewall" "web" {
  name          = "${var.name}-web"
  network       = var.network_self_link
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = [var.name]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"] # 80: ACME challenges + redirect to HTTPS
  }
}

resource "google_compute_firewall" "iap" {
  name          = "${var.name}-iap"
  network       = var.network_self_link
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = [var.name]

  allow {
    protocol = "tcp"
    ports    = ["22"] # admin shells via `gcloud compute ssh --tunnel-through-iap`
  }
}

# ---------------------------------------------------------------------------
# Instance + stable address + DNS
# ---------------------------------------------------------------------------

# Static: the domain's A record, the OAuth redirect URI, and the Let's
# Encrypt cert all key off this IP surviving instance replacement.
resource "google_compute_address" "this" {
  name   = var.name
  region = local.region
}

resource "google_compute_instance" "this" {
  name         = var.name
  zone         = var.zone
  machine_type = var.machine_type
  tags         = [var.name]
  labels       = var.labels

  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = data.google_compute_image.ubuntu_2404.self_link
      size  = 16
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = var.subnet_self_link

    access_config {
      nat_ip = google_compute_address.this.address
    }
  }

  service_account {
    email  = google_service_account.this.email
    scopes = ["cloud-platform"] # per-secret IAM is the real boundary
  }

  metadata_startup_script = templatefile("${path.module}/templates/init.sh.tpl", {
    domain                = var.domain
    acme_email            = var.acme_email
    oauth_secret_id       = var.oauth_secret_id
    allowed_email_domains = var.allowed_email_domains
    oauth2_proxy_version  = var.oauth2_proxy_version
    engine_param_prefix   = var.engine_param_prefix
    console_port          = var.console_port
    project               = local.project
    pkg_bucket            = var.package_tarball_path != null ? google_storage_bucket.pkg[0].name : ""
    pkg_object            = var.package_tarball_path != null ? google_storage_bucket_object.pkg[0].name : ""
    npm_package_spec      = var.npm_package_spec != null ? var.npm_package_spec : ""
    # Single source: the same shim the engine + snapshotd use.
    shim_b64 = base64encode(file("${path.module}/../../../../snapshotd/shims/gcp.sh"))
    # No package fingerprint here on purpose: releases go through the on-host
    # updater (md5Hash poll → npm install → service restart, ~20s). The
    # instance is replaced only when the bootstrap itself changes.
  })
}

resource "google_dns_record_set" "this" {
  count = var.managed_zone != null ? 1 : 0

  managed_zone = var.managed_zone
  name         = "${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_address.this.address]
}
