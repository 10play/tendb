# API verification token. Generated ephemerally and written with a write-only
# argument (secret_data_wo, google >= 6.25), so it never enters Terraform
# state.
#
# Rotation: bump var.token_secret_version. CAUTION: clone passwords are
# sha256(token:clone) — rotate only when running clones are disposable.
ephemeral "random_password" "token" {
  length  = 32
  special = false
}

resource "google_secret_manager_secret" "token" {
  secret_id = local.secret_ids["verification-token"]
  labels    = var.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "token" {
  secret                 = google_secret_manager_secret.token.id
  secret_data_wo         = ephemeral.random_password.token.result
  secret_data_wo_version = var.token_secret_version
}
