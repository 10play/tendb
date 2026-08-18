data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs     = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  private = var.mode == "private-nat"
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name = var.name
  cidr = var.cidr
  azs  = local.azs

  public_subnets  = [for i in range(var.az_count) : cidrsubnet(var.cidr, 8, 100 + i)]
  private_subnets = local.private ? [for i in range(var.az_count) : cidrsubnet(var.cidr, 4, i)] : []

  enable_nat_gateway = local.private
  single_nat_gateway = true

  tags = var.tags
}
