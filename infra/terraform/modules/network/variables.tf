variable "name" {
  description = "Name prefix for all network resources (e.g. quorumproof-prod-use1)."
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR. Must not overlap with peer regions."
  type        = string

  validation {
    condition     = can(cidrhost(var.cidr_block, 0))
    error_message = "cidr_block must be a valid IPv4 CIDR."
  }
}

variable "az_count" {
  description = "Number of availability zones to spread subnets across."
  type        = number
  default     = 3

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 6
    error_message = "az_count must be between 2 and 6."
  }
}

variable "single_nat_gateway" {
  description = "Use one shared NAT gateway (cheaper, non-HA). Use false in production."
  type        = bool
  default     = false
}

variable "flow_log_retention_days" {
  description = "CloudWatch retention for VPC flow logs."
  type        = number
  default     = 30
}
