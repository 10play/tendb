variable "name" {
  type    = string
  default = "tendb"
}

variable "cidr" {
  type    = string
  default = "10.60.0.0/24"
}

# public: the engine gets an external IP for egress (Docker pulls, apt,
#   dumping the source DB) — zero inbound exposure (the firewall admits
#   declared clients + the IAP range only; admin is IAP-only). Default
#   because Cloud NAT costs a monthly fee PLUS per-GB processing on every
#   nightly dump.
# nat: no external IPs; Cloud Router + Cloud NAT for egress, for orgs that
#   prohibit public addresses.
variable "mode" {
  type    = string
  default = "public"

  validation {
    condition     = contains(["public", "nat"], var.mode)
    error_message = "mode must be public or nat."
  }
}

variable "region" {
  description = "Region for the subnet (and NAT, in nat mode). null → the provider's region."
  type        = string
  default     = null
}
