resource "aws_security_group" "this" {
  name        = var.name
  description = "DBLab Engine API + clone Postgres ports"
  vpc_id      = var.vpc_id
  tags        = var.tags

  dynamic "ingress" {
    for_each = var.allowed_security_group_ids
    content {
      description     = "DBLab API"
      from_port       = 2345
      to_port         = 2345
      protocol        = "tcp"
      security_groups = [ingress.value]
    }
  }

  dynamic "ingress" {
    for_each = var.allowed_security_group_ids
    content {
      description     = "clone Postgres ports"
      from_port       = local.port_from
      to_port         = local.port_to
      protocol        = "tcp"
      security_groups = [ingress.value]
    }
  }

  dynamic "ingress" {
    for_each = length(var.allowed_cidr_blocks) > 0 ? [1] : []
    content {
      description = "DBLab API"
      from_port   = 2345
      to_port     = 2345
      protocol    = "tcp"
      cidr_blocks = var.allowed_cidr_blocks
    }
  }

  dynamic "ingress" {
    for_each = length(var.allowed_cidr_blocks) > 0 ? [1] : []
    content {
      description = "clone Postgres ports"
      from_port   = local.port_from
      to_port     = local.port_to
      protocol    = "tcp"
      cidr_blocks = var.allowed_cidr_blocks
    }
  }

  # Streaming-source setups run a sync-target Postgres on the host that the
  # hosted console probes in-VPC (see terraform/examples/aurora-source).
  dynamic "ingress" {
    for_each = var.sync_target_port != null && length(var.allowed_cidr_blocks) > 0 ? [1] : []
    content {
      description = "sync-target Postgres (streaming source)"
      from_port   = var.sync_target_port
      to_port     = var.sync_target_port
      protocol    = "tcp"
      cidr_blocks = var.allowed_cidr_blocks
    }
  }

  # Co-hosted console (Caddy terminates TLS on this host). SG-rule-only —
  # flipping console_ingress never touches user_data or the instance.
  dynamic "ingress" {
    for_each = var.console_ingress ? [80, 443] : []
    content {
      description = "console HTTP/HTTPS (Caddy on-host)"
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
