# tendb on AWS: minimal network + engine host. Scaffolded by `tendb init` —
# edit freely. Module sources are pinned; bump the ?ref= consciously (user_data
# changes REPLACE the host and destroy all branches).
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
  source = "@tendb-modules/aws/network"
  name   = var.name
}

module "engine" {
  source = "@tendb-modules/aws/engine"

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

  ami_id = var.engine_ami_id
}
