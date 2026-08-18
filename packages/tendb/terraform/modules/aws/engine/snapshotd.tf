# tendb-snapshotd, delivered out of band via SSM State Manager so the frozen
# user_data (see main.tf) is never touched: the association re-runs on every
# instance that carries the Role tag, so a replaced engine gets the daemon
# back automatically. Script + shim live in packages/tendb/snapshotd (single
# source; the association re-applies when their content changes).

locals {
  snapshotd_script = file("${path.module}/../../../../snapshotd/tendb-snapshotd.sh")
  snapshotd_unit   = file("${path.module}/../../../../snapshotd/tendb-snapshotd.service")
  snapshotd_shim   = file("${path.module}/../../../../snapshotd/shims/aws.sh")

  snapshotd_install = <<-EOT
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p /etc/tendb /var/lib/tendb
    base64 -d > /etc/tendb/platform-shim.sh <<'B64'
    ${base64encode(local.snapshotd_shim)}
    B64
    base64 -d > /usr/local/bin/tendb-snapshotd <<'B64'
    ${base64encode(local.snapshotd_script)}
    B64
    base64 -d > /etc/systemd/system/tendb-snapshotd.service <<'B64'
    ${base64encode(local.snapshotd_unit)}
    B64
    chmod 0755 /usr/local/bin/tendb-snapshotd
    cat > /etc/tendb/snapshotd.env <<'ENV'
    TENDB_PARAM_PREFIX=${local.ssm_prefix}
    TENDB_AWS_REGION=${local.region}
    ENV
    systemctl daemon-reload
    systemctl enable tendb-snapshotd
    systemctl restart tendb-snapshotd
    systemctl --no-pager status tendb-snapshotd || true
  EOT
}

resource "aws_ssm_document" "snapshotd_install" {
  name            = "${var.name}-snapshotd-install"
  document_type   = "Command"
  document_format = "YAML"

  content = yamlencode({
    schemaVersion = "2.2"
    description   = "Install/refresh tendb-snapshotd on the engine host"
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "install"
      inputs = { runCommand = [local.snapshotd_install] }
    }]
  })

  tags = var.tags
}

resource "aws_ssm_association" "snapshotd" {
  name             = aws_ssm_document.snapshotd_install.name
  association_name = "${var.name}-snapshotd"

  targets {
    key    = "tag:Role"
    values = [local.ssm_access_tag_value]
  }

  # Re-run whenever the document content changes (script/shim/unit edits).
  apply_only_at_cron_interval = false
}
