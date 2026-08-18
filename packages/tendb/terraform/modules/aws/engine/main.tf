# DBLab Engine host (postgres.ai) — ZFS thin clones of a source Postgres
# database. Private-first: no SSH, no key pair; admin via SSM Session Manager,
# API/DB access via the tendb CLI's SSM port-forwards.

# Ubuntu, not AL2023: ZFS is one `apt-get install zfsutils-linux`; AL2023 has
# no ZFS packages (a DKMS build would be fragile in user-data).
data "aws_ssm_parameter" "ubuntu_2404" {
  count = var.ami_id == null ? 1 : 0
  name  = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_instance" "this" {
  ami                         = var.ami_id != null ? var.ami_id : data.aws_ssm_parameter.ubuntu_2404[0].value
  instance_type               = local.instance_type
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [aws_security_group.this.id]
  iam_instance_profile        = aws_iam_instance_profile.this.name
  associate_public_ip_address = var.associate_public_ip

  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = local.root_volume_gb
  }

  # ZFS pool device — thin clones + the logical dump live here.
  ebs_block_device {
    device_name           = "/dev/sdf"
    volume_type           = "gp3"
    volume_size           = local.data_volume_gb
    iops                  = local.data_volume_iops
    throughput            = local.data_volume_throughput
    delete_on_termination = true
  }

  # FROZEN TEMPLATE: the rendered bytes must stay identical for existing
  # deploys — even a comment edit in init.sh.tpl changes user_data, which
  # (user_data_replace_on_change below) REPLACES the instance and destroys
  # the ZFS pool with every branch on it. Grep every plan for "must be
  # replaced" before applying; this module must never appear.
  user_data = templatefile("${path.module}/templates/init.sh.tpl", {
    region                 = local.region
    source_secret_id       = var.source_secret_arn
    source_secret_json_key = var.source_secret_json_key == null ? "" : var.source_secret_json_key
    token_param            = aws_ssm_parameter.token.name
    dbname_param           = aws_ssm_parameter.dbname.name
    server_image           = var.server_image
    clone_image            = local.clone_image
    ui_enabled             = var.ui_enabled
    ui_image               = var.ui_image
    refresh_cron           = var.refresh_cron
    skip_start_refresh     = var.skip_start_refresh
    streaming_snapshots    = var.streaming_snapshots
    port_pool_from         = local.port_from
    port_pool_to           = local.port_to
    shm_size               = local.shm_size
    postgres_configs       = local.postgres_configs
    exclude_extensions     = var.dump_exclude_extensions
    dump_parallel_jobs     = local.dump_parallel_jobs
    restore_parallel_jobs  = local.restore_parallel_jobs
    max_idle_minutes       = var.clone_max_idle_minutes
    logs_retention_days    = var.logs_retention_days
  })
  # CAUTION: any user_data change replaces the instance — every clone dies and
  # the data re-syncs from the source at boot.
  user_data_replace_on_change = true

  tags = merge(var.tags, {
    Name = var.name
    Role = local.ssm_access_tag_value # client IAM conditions key off this tag
  })
}

# ---------------------------------------------------------------------------
# Discovery for the CLI/CI: params vanish with this module — the absence of
# instance-id is the "platform is down, nothing to delete" signal.
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "instance_id" {
  name  = "${local.ssm_prefix}/instance-id"
  type  = "String"
  value = aws_instance.this.id
  tags  = var.tags
}

resource "aws_ssm_parameter" "host" {
  name  = "${local.ssm_prefix}/host"
  type  = "String"
  value = aws_instance.this.private_ip
  tags  = var.tags
}

# Written by the host at boot (it learns the db name by parsing the source
# URL); Terraform owns the lifecycle so `destroy` cleans it up.
resource "aws_ssm_parameter" "dbname" {
  name  = "${local.ssm_prefix}/dbname"
  type  = "String"
  value = "unknown"
  tags  = var.tags

  lifecycle {
    ignore_changes = [value]
  }
}

# Capacity readout for `tendb status` (clone cap = port-pool width).
resource "aws_ssm_parameter" "port_pool" {
  name  = "${local.ssm_prefix}/port-pool"
  type  = "String"
  value = "${local.port_from}-${local.port_to}"
  tags  = var.tags
}
