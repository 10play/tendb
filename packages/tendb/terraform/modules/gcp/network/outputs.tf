output "network_self_link" {
  value = google_compute_network.this.self_link
}

output "subnet_self_link" {
  value = google_compute_subnetwork.this.self_link
}

output "cidr" {
  value = var.cidr
}

output "assign_external_ip" {
  description = "Wire straight into the engine module's assign_external_ip."
  value       = !local.nat
}
