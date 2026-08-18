resource "google_service_account" "engine" {
  account_id   = "${var.name}-engine"
  display_name = "${var.name} DBLab engine host"
}

# The HOST pulls the source URL + its own token at boot — credentials never
# transit metadata, Terraform values, or CI. Every contract secret exists in
# Terraform, so per-secret grants suffice: no project-wide role anywhere.

resource "google_secret_manager_secret_iam_member" "engine_accessor" {
  for_each  = google_secret_manager_secret.params
  project   = each.value.project
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.engine.email}"
}

resource "google_secret_manager_secret_iam_member" "engine_token_accessor" {
  project   = google_secret_manager_secret.token.project
  secret_id = google_secret_manager_secret.token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.engine.email}"
}

# init publishes the parsed db name at boot (pf_put_param dbname).
resource "google_secret_manager_secret_iam_member" "engine_dbname_adder" {
  project   = google_secret_manager_secret.params["dbname"].project
  secret_id = google_secret_manager_secret.params["dbname"].secret_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.engine.email}"
}

# The source-URL secret is created out of band (the URL must never land in
# TF state) — only its grant lives here.
resource "google_secret_manager_secret_iam_member" "engine_source" {
  project   = local.project
  secret_id = var.source_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.engine.email}"
}
