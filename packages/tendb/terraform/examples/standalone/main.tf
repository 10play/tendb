# Greenfield deployment: minimal network + engine in a fresh AWS account.
#
# The source secret is created OUT of band (the URL must never land in TF
# state):
#   aws secretsmanager create-secret --name tendb/source-url \
#     --secret-string 'postgres://user:pass@host:5432/dbname'

terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = { project = var.name, "managed-by" = "terraform" }
  }
}

module "network" {
  source = "../../modules/aws/network"
  name   = var.name
}

module "engine" {
  source = "../../modules/aws/engine"

  name                = var.name
  vpc_id              = module.network.vpc_id
  subnet_id           = module.network.engine_subnet_id
  associate_public_ip = module.network.associate_public_ip
  allowed_cidr_blocks = [module.network.vpc_cidr] # in-VPC clients; the CLI tunnels via SSM regardless

  size                    = var.size
  postgres_major_version  = var.postgres_major_version
  source_secret_arn       = var.source_secret_arn
  source_secret_json_key  = var.source_secret_json_key
  dump_exclude_extensions = var.dump_exclude_extensions

  create_client_iam_policy = true
  sync_target_port         = var.sync_target_port
  streaming_snapshots      = var.streaming_snapshots

  ami_id          = var.engine_ami_id
  console_ingress = var.console_on_engine
}

# --- console-on-engine (cheapest hosting: no second instance) -------------
# The engine host runs Caddy + oauth2-proxy + the console service, installed
# by terraform/scripts/engine-console-install.sh (SSM, not user_data — the
# engine's user_data is frozen). Terraform owns the package bucket the
# on-host updater polls and the extra permissions the engine role needs.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# The console's public identity. Held at the root (not in modules/console) so
# it survives the dedicated console stack: the sslip.io domain encodes this
# IP, so keeping the allocation keeps the URL, the Google OAuth redirect URI,
# and the Let's Encrypt cert name. Associating it with the engine instance IS
# the cutover.
resource "aws_eip" "console" {
  count  = var.console_on_engine ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.name}-console" }
}

resource "aws_eip_association" "console" {
  count               = var.console_on_engine ? 1 : 0
  allocation_id       = aws_eip.console[0].id
  instance_id         = module.engine.instance_id
  allow_reassociation = true
}

resource "aws_s3_bucket" "pkg" {
  count         = var.console_on_engine && var.package_tarball_path != null ? 1 : 0
  bucket        = "${var.name}-pkg-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "pkg" {
  count                   = var.console_on_engine && var.package_tarball_path != null ? 1 : 0
  bucket                  = aws_s3_bucket.pkg[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "pkg" {
  count  = var.console_on_engine && var.package_tarball_path != null ? 1 : 0
  bucket = aws_s3_bucket.pkg[0].id
  key    = "tendb.tgz"
  source = var.package_tarball_path
  # ETag change is the on-host updater's release signal.
  etag = filemd5(var.package_tarball_path)
}

data "aws_iam_policy_document" "engine_console" {
  count = var.console_on_engine ? 1 : 0

  dynamic "statement" {
    for_each = var.package_tarball_path != null ? [1] : []
    content {
      sid       = "PkgRead"
      actions   = ["s3:GetObject"]
      resources = ["${aws_s3_bucket.pkg[0].arn}/*"]
    }
  }

  statement {
    sid       = "OauthSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${var.oauth_secret_arn}*"]
  }

  # Console-writable runtime config (schedule, alerts, schema heal). Reads
  # are already covered by the engine role's prefix-wide GetParameter.
  statement {
    sid     = "ConsoleParams"
    actions = ["ssm:PutParameter"]
    resources = [
      for sub in ["snapshots", "alerts", "schema"] :
      "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${module.engine.ssm_prefix}/${sub}/*"
    ]
  }
}

resource "aws_iam_role_policy" "engine_console" {
  count  = var.console_on_engine ? 1 : 0
  name   = "console-on-engine"
  role   = module.engine.instance_role_name
  policy = data.aws_iam_policy_document.engine_console[0].json
}

# Optional hosted console: https://<console_domain>, Google login restricted
# to allowed_email_domains. Prereqs (see modules/console/README.md): a Google
# OAuth client in Secrets Manager, a domain, and a packed CLI tarball.
module "console" {
  count  = var.enable_console ? 1 : 0
  source = "../../modules/aws/console"

  name      = "${var.name}-console"
  vpc_id    = module.network.vpc_id
  subnet_id = module.network.engine_subnet_id # public in the default network mode

  domain                = var.console_domain
  instance_type         = var.console_instance_type
  hosted_zone_id        = var.hosted_zone_id
  acme_email            = var.acme_email
  oauth_secret_arn      = var.oauth_secret_arn
  allowed_email_domains = var.allowed_email_domains
  package_tarball_path  = var.package_tarball_path
  engine_ssm_prefix     = module.engine.ssm_prefix
}
