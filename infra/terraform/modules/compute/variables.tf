variable "name" {
  description = "Name prefix (e.g. quorumproof-prod-use1)."
  type        = string
}

variable "vpc_id" {
  description = "VPC to deploy into."
  type        = string
}

variable "vpc_cidr_block" {
  description = "VPC CIDR (used to scope ALB egress)."
  type        = string
}

variable "public_subnet_ids" {
  description = "Subnets for the ALB."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Subnets for the api-server tasks."
  type        = list(string)
}

variable "image" {
  description = "Fully-qualified api-server image (registry/repo@sha256:digest preferred)."
  type        = string
}

variable "container_port" {
  description = "Port the api-server listens on (matches api-server/Dockerfile)."
  type        = number
  default     = 3001
}

variable "cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Fargate task memory (MiB)."
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Baseline number of api-server tasks (also the autoscaling minimum)."
  type        = number
  default     = 2
}

variable "max_count" {
  description = "Autoscaling maximum number of api-server tasks."
  type        = number
  default     = 10
}

variable "certificate_arn" {
  description = "ACM certificate for the HTTPS listener (must live in this region)."
  type        = string
}

variable "region_role" {
  description = "Failover role of this region: \"primary\" or \"secondary\" (#1650)."
  type        = string
  default     = "primary"

  validation {
    condition     = contains(["primary", "secondary"], var.region_role)
    error_message = "region_role must be \"primary\" or \"secondary\"."
  }
}

variable "environment" {
  description = "Plain-text environment variables for the api-server container."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "Map of env var name → Secrets Manager ARN injected into the container."
  type        = map(string)
  default     = {}
}

variable "log_retention_days" {
  description = "CloudWatch retention for api-server logs before they only exist in the archive (#1653)."
  type        = number
  default     = 30
}

variable "log_kms_key_arn" {
  description = "Optional KMS key for CloudWatch log encryption."
  type        = string
  default     = null
}

variable "alb_access_log_bucket" {
  description = "Optional S3 bucket for ALB access logs."
  type        = string
  default     = null
}

variable "deletion_protection" {
  description = "Enable ALB deletion protection."
  type        = bool
  default     = true
}
