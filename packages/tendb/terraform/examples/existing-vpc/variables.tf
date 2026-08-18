variable "name" {
  type    = string
  default = "tendb"
}

variable "region" {
  type    = string
  default = "eu-north-1"
}

variable "vpc_id" {
  type = string
}

variable "subnet_id" {
  type = string
}

variable "allowed_security_group_ids" {
  type    = list(string)
  default = []
}

variable "postgres_major_version" {
  type = number
}

variable "source_secret_arn" {
  type = string
}

variable "source_secret_json_key" {
  type    = string
  default = null
}

variable "ssm_prefix" {
  type    = string
  default = null
}
