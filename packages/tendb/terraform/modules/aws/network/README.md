# tendb network module

Minimal VPC for a standalone engine deployment. Skip it entirely when you
already have a VPC — the engine module only needs `vpc_id` + `subnet_id`.

Two modes:

- **`public`** (default): public subnets + IGW, no NAT; give the engine
  `associate_public_ip = true` (wired via the `associate_public_ip` output).
  The host needs egress either way (Docker pulls, apt, dumping the source DB),
  and a public IP costs ~$3.65/mo with zero inbound exposure (the SG admits
  declared clients only; admin is SSM-only). NAT would cost ~$33/mo **plus**
  $0.045/GB of processing on every nightly dump — ~$135/mo at 100 GB.
- **`private-nat`**: private subnets + single NAT gateway, for orgs that
  prohibit public IPs. Accept the dump-processing cost consciously.

```hcl
module "network" {
  source = "…/tendb/terraform/modules/network"
  name   = "tendb"
  # mode = "private-nat"
}

module "engine" {
  source              = "…/tendb/terraform/modules/engine"
  vpc_id              = module.network.vpc_id
  subnet_id           = module.network.engine_subnet_id
  associate_public_ip = module.network.associate_public_ip
  allowed_cidr_blocks = [module.network.vpc_cidr]
  # …
}
```
