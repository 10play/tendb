variable "name" {
  type    = string
  default = "tendb"
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "cidr" {
  type    = string
  default = "10.60.0.0/16"
}

# default: rely on Azure's default outbound access for engine egress (Docker
#   pulls, apt, dumping the source DB) — free, but Azure retired it for
#   subnets created after 2025-09-30, so new deployments may come up with no
#   internet path (init hangs on apt/docker). See the README.
# nat: NAT gateway on the engine subnet (~$32/mo + $0.045/GB processed —
#   nightly dumps add up), for subscriptions where default outbound is gone
#   or prohibited.
variable "mode" {
  type    = string
  default = "default"

  validation {
    condition     = contains(["default", "nat"], var.mode)
    error_message = "mode must be default or nat."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
