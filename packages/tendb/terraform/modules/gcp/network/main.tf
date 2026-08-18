locals {
  nat = var.mode == "nat"
}

resource "google_compute_network" "this" {
  name                    = var.name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "this" {
  name          = var.name
  network       = google_compute_network.this.id
  ip_cidr_range = var.cidr
  region        = var.region

  # Metadata / Secret Manager / GCS reachable without an external IP.
  private_ip_google_access = true
}

resource "google_compute_router" "this" {
  count = local.nat ? 1 : 0

  name    = "${var.name}-router"
  network = google_compute_network.this.id
  region  = var.region
}

resource "google_compute_router_nat" "this" {
  count = local.nat ? 1 : 0

  name                               = "${var.name}-nat"
  router                             = google_compute_router.this[0].name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}
