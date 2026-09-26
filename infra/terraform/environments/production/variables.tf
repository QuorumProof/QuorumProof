variable "primary_region" {
  description = "Active region. Must be us-east-1 while it also hosts the Route 53 health-check alarms."
  type        = string
  default     = "us-east-1"
}

variable "secondary_region" {
  description = "Standby (failover) region."
  type        = string
  default     = "eu-west-1"
}

variable "primary_cidr" {
  description = "VPC CIDR in the primary region."
  type        = string
  default     = "10.10.0.0/16"
}

variable "secondary_cidr" {
  description = "VPC CIDR in the secondary region (must not overlap primary)."
  type        = string
  default     = "10.20.0.0/16"
}

variable "api_image" {
  description = "api-server image, pinned by digest. Must be replicated to both regions' registries (or be public)."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone for the public API hostname."
  type        = string
}

variable "api_domain" {
  description = "Public API hostname (failover-routed)."
  type        = string
  default     = "api.quorumproof.io"
}

variable "primary_certificate_arn" {
  description = "ACM certificate in the primary region covering api_domain and the regional hostname."
  type        = string
}

variable "secondary_certificate_arn" {
  description = "ACM certificate in the secondary region covering api_domain and the regional hostname."
  type        = string
}

variable "api_environment" {
  description = "Non-secret env vars for the api-server (STELLAR_RPC_URL, contract ids, ...)."
  type        = map(string)
  default     = {}
}

variable "api_secret_names" {
  description = "Env var name → Secrets Manager secret name. The secret must exist (replicated) in both regions."
  type        = map(string)
  default     = {}
}

variable "alert_emails" {
  description = "On-call addresses for failover alerts."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "Hot (CloudWatch) log retention in days (#1653)."
  type        = number
  default     = 30
}
