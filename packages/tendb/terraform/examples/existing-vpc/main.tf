# Engine-only deployment into an existing VPC (the legacy-POC-shaped setup:
# private subnet, clients identified by security group, custom SSM prefix).

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
}

module "engine" {
  source = "../../modules/engine"

  name                       = var.name
  vpc_id                     = var.vpc_id
  subnet_id                  = var.subnet_id
  allowed_security_group_ids = var.allowed_security_group_ids

  size                   = "small"
  postgres_major_version = var.postgres_major_version

  # Override demo: grow the pool volume and one PG knob beyond the preset.
  data_volume_gb   = 50
  postgres_configs = { work_mem = "48MB" }

  source_secret_arn      = var.source_secret_arn
  source_secret_json_key = var.source_secret_json_key

  # Custom namespace, e.g. "/tendb-poc/dblab" to stay compatible with an
  # existing consumer fleet.
  ssm_prefix = var.ssm_prefix
}

output "cli_discovery" {
  value = module.engine.ssm_parameter_names
}
