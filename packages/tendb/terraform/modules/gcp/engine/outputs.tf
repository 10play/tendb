output "instance_path" {
  description = "The CLI's opaque tunnel target (also published as instance-id)."
  value       = "projects/${local.project}/zones/${var.zone}/instances/${google_compute_instance.this.name}"
}

output "instance_self_link" {
  value = google_compute_instance.this.self_link
}

output "private_ip" {
  value = google_compute_instance.this.network_interface[0].network_ip
}

output "public_ip" {
  value = try(google_compute_instance.this.network_interface[0].access_config[0].nat_ip, null)
}

output "service_account_email" {
  description = "Grant extra secrets here (e.g. more sync sources)."
  value       = google_service_account.engine.email
}

output "network_tag" {
  description = "Attach extra firewall rules to this target tag."
  value       = local.network_tag
}

output "param_prefix" {
  value = local.param_prefix
}

output "secret_names" {
  description = "The tendb CLI's discovery contract (mapped Secret Manager ids)."
  value = {
    instance_id        = local.secret_ids["instance-id"]
    host               = local.secret_ids["host"]
    verification_token = local.secret_ids["verification-token"]
    dbname             = local.secret_ids["dbname"]
    port_pool          = local.secret_ids["port-pool"]
  }
}

output "api_port" {
  value = 2345
}

output "clone_port_range" {
  value = { from = local.port_from, to = local.port_to }
}

output "client_iam_snippet" {
  description = "Terraform to grant a CI/operator principal tunnel + discovery access (GCP mirror of the AWS client policy output)."
  value       = <<-EOT
    # IAP tunnel into the engine VM (the CLI's transport):
    resource "google_iap_tunnel_instance_iam_member" "tendb_client" {
      project  = "${local.project}"
      zone     = "${var.zone}"
      instance = "${google_compute_instance.this.name}"
      role     = "roles/iap.tunnelResourceAccessor"
      member   = "user:you@example.com"
    }

    # Discovery + token (the CLI derives clone passwords from the token):
    resource "google_secret_manager_secret_iam_member" "tendb_client_read" {
      for_each  = toset(${jsonencode(values(local.secret_ids))})
      project   = "${local.project}"
      secret_id = each.value
      role      = "roles/secretmanager.secretAccessor"
      member    = "user:you@example.com"
    }

    # Only for principals that run `tendb snapshots …` / `tendb schema sync`:
    resource "google_secret_manager_secret_iam_member" "tendb_client_write" {
      for_each  = toset(${jsonencode([for k in local.client_write_keys : local.secret_ids[k]])})
      project   = "${local.project}"
      secret_id = each.value
      role      = "roles/secretmanager.secretVersionAdder"
      member    = "user:you@example.com"
    }
  EOT
}
