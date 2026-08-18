# Aurora "customer production" simulator for the streaming-sync rehearsal:
# a minimal Aurora Serverless v2 Postgres cluster that logically replicates
# every change to a Neon database (the tendb engine's dump source), per
# Option B of the implementation plan. Deliberately tiny — min 0 / max 1 ACU,
# one writer, default VPC — and fully disposable via `terraform destroy`.
#
# Own state on purpose: nothing here touches examples/standalone's resources.

terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = { project = var.name, "managed-by" = "terraform" }
  }
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = data.aws_subnets.default.ids
}

# 5432 open to the tendb hosts (the engine-host subscriber dials in, the
# hosted console probes replication state) and to the operator. Nothing else.
# NOTE: description is create-only on aws_security_group — editing it forces a
# delete-and-recreate that deadlocks against the cluster's RDS-managed ENI, so
# the original wording stays frozen.
resource "aws_security_group" "aurora" {
  name        = var.name
  description = "Aurora publisher: Neon subscriber egress IPs + operator"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "tendb engine host + hosted console"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.client_cidrs
  }

  dynamic "ingress" {
    for_each = var.admin_cidrs
    content {
      description = "operator"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# rds.logical_replication is static (sets wal_level=logical at boot). A brand
# new cluster picks it up on first provision; verify with `show wal_level`.
resource "aws_rds_cluster_parameter_group" "logical" {
  name   = "${var.name}-logical"
  family = "aurora-postgresql${split(".", var.engine_version)[0]}"

  parameter {
    name         = "rds.logical_replication"
    value        = "1"
    apply_method = "pending-reboot"
  }
}

resource "random_password" "master" {
  length  = 32
  special = false
}

resource "aws_rds_cluster" "this" {
  cluster_identifier              = var.name
  engine                          = "aurora-postgresql"
  engine_mode                     = "provisioned"
  engine_version                  = var.engine_version
  database_name                   = var.database
  master_username                 = "postgres"
  master_password                 = random_password.master.result
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.logical.name
  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [aws_security_group.aurora.id]
  storage_encrypted               = true
  skip_final_snapshot             = true
  apply_immediately               = true

  serverlessv2_scaling_configuration {
    min_capacity             = 0
    max_capacity             = 1
    seconds_until_auto_pause = 3600
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier          = "${var.name}-writer"
  cluster_identifier  = aws_rds_cluster.this.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.this.engine
  engine_version      = aws_rds_cluster.this.engine_version
  publicly_accessible = true
}

# The console's replication view discovers the publisher through this SSM
# parameter (same prefix the engine publishes under, so the hosted console's
# existing GetParameter policy already covers it).
resource "aws_ssm_parameter" "publisher_url" {
  name  = "${var.engine_ssm_prefix}/replication/publisher-url"
  type  = "SecureString"
  value = "postgres://postgres:${random_password.master.result}@${aws_rds_cluster.this.endpoint}:5432/${var.database}?sslmode=require"
}

# The hosted console reaches the sync target (engine host :5433) in-VPC.
# That ingress lives in the ENGINE module (inline-rule SG = exclusive rule
# ownership): apply examples/standalone with `sync_target_port = 5433`.
