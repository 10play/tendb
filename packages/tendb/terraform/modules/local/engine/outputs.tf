output "api_url" {
  description = "DBLab API on the host loopback (the CLI still goes through discovery — this is for curl)."
  value       = "http://127.0.0.1:2345"
}

output "params_path" {
  description = "The params.json the CLI reads (tendb.json stateDir must be its directory)."
  value       = local_sensitive_file.params.filename
}

output "engine_container" {
  value = docker_container.dblab_server.name
}

output "snapshotd_container" {
  value = docker_container.snapshotd.name
}

output "param_prefix" {
  value = local.param_prefix
}

output "clone_port_range" {
  value = "${module.presets.port_from}-${module.presets.port_to}"
}

output "cli_discovery" {
  description = "Drop into tendb.json (or export TENDB_PLATFORM/TENDB_STATE_DIR)."
  value = jsonencode({
    platform = "local"
    stateDir = var.state_dir
  })
}
