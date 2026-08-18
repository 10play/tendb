# The engine contract, as a params.json the CLI's FileParamStore and the
# snapshotd container both read (verbatim keys — see ENGINE-CONTRACT.md).
# tendb-snapshotd rewrites this file atomically when it updates params, so
# terraform ignores drift in content beyond its own keys via replace-on-apply
# semantics (local_sensitive_file rewrites the whole file; runtime keys the
# daemon added are re-created by it on the next tick).

resource "local_sensitive_file" "params" {
  filename        = "${var.state_dir}/params.json"
  file_permission = "0600"

  content = jsonencode({
    "${local.param_prefix}/instance-id" = { value = local.container }
    "${local.param_prefix}/host"        = { value = "127.0.0.1" }
    "${local.param_prefix}/verification-token" = {
      value  = random_password.token.result
      secure = true
    }
    "${local.param_prefix}/dbname"    = { value = local.db_name }
    "${local.param_prefix}/port-pool" = { value = "${module.presets.port_from}-${module.presets.port_to}" }
  })
}
