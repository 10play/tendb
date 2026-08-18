variable "name" {
  type    = string
  default = "tendb"
}

variable "cidr" {
  type    = string
  default = "10.60.0.0/16"
}

# public: engine gets a public IP for egress (Docker pulls, apt, dumping the
#   source DB) — ~$3.65/mo, zero inbound exposure (SG admits declared clients
#   only; admin is SSM-only). Default because NAT costs ~$33/mo PLUS
#   $0.045/GB on every nightly dump (a 100 GB dump ≈ $135/mo of processing).
# private-nat: private subnets + single NAT, for orgs that prohibit public IPs.
variable "mode" {
  type    = string
  default = "public"

  validation {
    condition     = contains(["public", "private-nat"], var.mode)
    error_message = "mode must be public or private-nat."
  }
}

variable "az_count" {
  type    = number
  default = 2
}

variable "tags" {
  type    = map(string)
  default = {}
}
