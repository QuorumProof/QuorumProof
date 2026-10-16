variable "name" {
  description = "Name prefix."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone that owns record_name."
  type        = string
}

variable "record_name" {
  description = "Public API hostname clients use (e.g. api.quorumproof.io)."
  type        = string
}

variable "regions" {
  description = <<-EOT
    Map of region key → endpoint. Exactly one entry must have role = "primary"
    and one role = "secondary".
  EOT
  type = map(object({
    role              = string
    alb_dns_name      = string
    alb_zone_id       = string
    health_check_fqdn = string
  }))

  validation {
    condition = (
      length([for r in values(var.regions) : r if r.role == "primary"]) == 1 &&
      length([for r in values(var.regions) : r if r.role == "secondary"]) == 1 &&
      length(var.regions) == 2
    )
    error_message = "regions must contain exactly one primary and one secondary entry."
  }
}

variable "health_check_path" {
  description = "Path probed by Route 53 health checkers."
  type        = string
  default     = "/health/ready"
}

variable "request_interval" {
  description = "Seconds between health checks (10 or 30)."
  type        = number
  default     = 10

  validation {
    condition     = contains([10, 30], var.request_interval)
    error_message = "request_interval must be 10 or 30."
  }
}

variable "failure_threshold" {
  description = "Consecutive failures before a region is considered unhealthy."
  type        = number
  default     = 3
}

variable "checker_regions" {
  description = "Route 53 checker locations (minimum 3)."
  type        = list(string)
  default     = ["us-east-1", "us-west-2", "eu-west-1"]
}

variable "alert_emails" {
  description = "Addresses subscribed to failover alerts."
  type        = list(string)
  default     = []
}
