variable "subscription_id" {
  description = "Azure subscription to deploy into. null → ARM_SUBSCRIPTION_ID."
  type        = string
  default     = null
}

variable "location" {
  type    = string
  default = "northeurope"
}

variable "name" {
  type    = string
  default = "tendb"
}

variable "size" {
  description = "small | medium | large | xlarge."
  type        = string
  default     = "small"
}

variable "postgres_major_version" {
  description = "Postgres major of the SOURCE database (the clone image must match)."
  type        = number
}

variable "source_secret_name" {
  description = "Key Vault secret holding the source Postgres URL — created out of band in the engine vault (see main.tf's bootstrap note)."
  type        = string
  default     = "tendb-source-url"
}

variable "source_secret_json_key" {
  description = "JSON key inside the secret holding the URL. null → the whole value is the URL."
  type        = string
  default     = null
}

variable "dump_exclude_extensions" {
  type    = list(string)
  default = []
}

variable "streaming_snapshots" {
  type    = bool
  default = false
}

variable "admin_ssh_public_key" {
  description = "SSH public key for the VMs (azurerm requires one; access rides the Bastion)."
  type        = string
}

variable "network_mode" {
  description = "default | nat (Azure retired default outbound access for subnets created after 2025-09-30)."
  type        = string
  default     = "default"
}
