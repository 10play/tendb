# GCP allows all egress by default — only ingress rules live here.

# Direct TCP for declared in-VPC clients (apps, the hosted console). The CLI
# rides IAP tunnels regardless.
resource "google_compute_firewall" "clients" {
  count = length(var.client_cidr_ranges) > 0 ? 1 : 0

  name          = "${var.name}-engine-clients"
  network       = var.network_self_link
  direction     = "INGRESS"
  source_ranges = var.client_cidr_ranges
  target_tags   = [local.network_tag]

  allow {
    protocol = "tcp"
    ports = concat(
      ["2345", "${local.port_from}-${local.port_to}"],
      # Streaming-source setups run a sync-target Postgres the hosted console
      # probes in-VPC.
      var.sync_target_port == null ? [] : [tostring(var.sync_target_port)],
    )
  }
}

# `gcloud compute start-iap-tunnel` enters from Google's fixed IAP block:
# API (2345), embedded UI (2346), clone ports, and 22 for admin shells over
# IAP (no public SSH anywhere).
resource "google_compute_firewall" "iap" {
  name          = "${var.name}-engine-iap"
  network       = var.network_self_link
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = [local.network_tag]

  allow {
    protocol = "tcp"
    ports    = ["22", "2345", "2346", "${local.port_from}-${local.port_to}"]
  }
}

# Co-hosted console (Caddy terminates TLS on this host). Firewall-only —
# flipping console_ingress never touches the startup script or the instance.
resource "google_compute_firewall" "console" {
  count = var.console_ingress ? 1 : 0

  name          = "${var.name}-engine-console"
  network       = var.network_self_link
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = [local.network_tag]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}
