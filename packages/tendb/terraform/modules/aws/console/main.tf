# Deployed tendb console: the same server `tendb console` runs locally,
# hosted in-VPC next to the engine (direct TCP — no SSM tunnels), behind
# oauth2-proxy (Google, domain-restricted) and Caddy (automatic HTTPS).
#
# Request path:  browser → :443 Caddy → :4180 oauth2-proxy → :4400 console
# The console itself binds loopback only; the token and clone credentials
# never reach the browser.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
}

data "aws_ssm_parameter" "ubuntu_2404" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

# ---------------------------------------------------------------------------
# Package delivery: local tarball → private S3 object the host pulls at boot.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "pkg" {
  count         = var.package_tarball_path != null ? 1 : 0
  bucket        = "${var.name}-pkg-${local.account_id}"
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "pkg" {
  count                   = var.package_tarball_path != null ? 1 : 0
  bucket                  = aws_s3_bucket.pkg[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "pkg" {
  count  = var.package_tarball_path != null ? 1 : 0
  bucket = aws_s3_bucket.pkg[0].id
  key    = "tendb.tgz"
  source = var.package_tarball_path
  etag   = filemd5(var.package_tarball_path)
  tags   = var.tags
}

# ---------------------------------------------------------------------------
# Network / identity
# ---------------------------------------------------------------------------

resource "aws_security_group" "this" {
  name        = var.name
  description = "tendb console: public HTTPS (auth handled by oauth2-proxy)"
  vpc_id      = var.vpc_id
  tags        = var.tags

  ingress {
    description = "HTTP (ACME challenges + redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = var.name
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "boot" {
  statement {
    sid       = "EngineDiscovery"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${local.region}:${local.account_id}:parameter${var.engine_ssm_prefix}/*"]
  }

  # The console writes the snapshot schedule + on-demand requests, the Slack
  # alert webhook, and schema-sync requests/config (the engine host's executor
  # reads them). Scoped to those subtrees only.
  statement {
    sid     = "SnapshotAndAlertControl"
    actions = ["ssm:PutParameter"]
    resources = [
      "arn:aws:ssm:${local.region}:${local.account_id}:parameter${var.engine_ssm_prefix}/snapshots/*",
      "arn:aws:ssm:${local.region}:${local.account_id}:parameter${var.engine_ssm_prefix}/alerts/*",
      "arn:aws:ssm:${local.region}:${local.account_id}:parameter${var.engine_ssm_prefix}/schema/*",
    ]
  }

  statement {
    sid       = "OauthClientSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${var.oauth_secret_arn}*"]
  }

  dynamic "statement" {
    for_each = var.package_tarball_path != null ? [1] : []
    content {
      sid       = "PackageDownload"
      actions   = ["s3:GetObject"]
      resources = ["${aws_s3_bucket.pkg[0].arn}/*"]
    }
  }
}

resource "aws_iam_role_policy" "boot" {
  name   = "${var.name}-boot"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.boot.json
}

resource "aws_iam_instance_profile" "this" {
  name = var.name
  role = aws_iam_role.this.name
  tags = var.tags
}

# ---------------------------------------------------------------------------
# Instance + stable address + DNS
# ---------------------------------------------------------------------------

resource "aws_instance" "this" {
  ami                    = data.aws_ssm_parameter.ubuntu_2404.value
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.this.id]
  iam_instance_profile   = aws_iam_instance_profile.this.name

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 16
  }

  user_data = templatefile("${path.module}/templates/init.sh.tpl", {
    region                = local.region
    domain                = var.domain
    acme_email            = var.acme_email
    oauth_secret_id       = var.oauth_secret_arn
    allowed_email_domains = var.allowed_email_domains
    oauth2_proxy_version  = var.oauth2_proxy_version
    engine_ssm_prefix     = var.engine_ssm_prefix
    console_port          = var.console_port
    pkg_s3_uri            = var.package_tarball_path != null ? "s3://${aws_s3_bucket.pkg[0].id}/${aws_s3_object.pkg[0].key}" : ""
    npm_package_spec      = var.npm_package_spec != null ? var.npm_package_spec : ""
    # No package fingerprint here on purpose: releases go through the on-host
    # updater (S3 ETag poll → npm install → service restart, ~20s). The
    # instance is replaced only when the bootstrap itself changes.
  })
  user_data_replace_on_change = true

  tags = merge(var.tags, { Name = var.name })
}

resource "aws_eip" "this" {
  domain   = "vpc"
  instance = aws_instance.this.id
  tags     = merge(var.tags, { Name = var.name })
}

resource "aws_route53_record" "this" {
  count   = var.hosted_zone_id != null ? 1 : 0
  zone_id = var.hosted_zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.this.public_ip]
}
