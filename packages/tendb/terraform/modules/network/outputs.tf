output "vpc_id" {
  value = module.vpc.vpc_id
}

output "vpc_cidr" {
  value = var.cidr
}

output "engine_subnet_id" {
  description = "Where the engine host should live (first private subnet in private-nat mode, first public otherwise)."
  value       = local.private ? module.vpc.private_subnets[0] : module.vpc.public_subnets[0]
}

output "subnet_ids" {
  value = local.private ? module.vpc.private_subnets : module.vpc.public_subnets
}

output "associate_public_ip" {
  description = "Wire straight into the engine module's associate_public_ip."
  value       = !local.private
}
