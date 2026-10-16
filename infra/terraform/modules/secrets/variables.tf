# infra/terraform/modules/secrets/variables.tf
# Issue #1656: Secrets management — HashiCorp Vault via AWS Secrets Manager.

variable "environment" {
  description = "Deployment environment (staging, production)."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "project" {
  description = "Project name used as a prefix for all secret paths."
  type        = string
  default     = "quorumproof"
}

variable "aws_region" {
  description = "AWS region where secrets are stored."
  type        = string
  default     = "us-east-1"
}

variable "kms_key_arn" {
  description = "ARN of the KMS key used to encrypt secrets at rest. If empty, the default AWS Secrets Manager KMS key is used."
  type        = string
  default     = ""
}

variable "rotation_lambda_arn" {
  description = "ARN of the Lambda function used for automatic secret rotation. Set to enable rotation."
  type        = string
  default     = ""
}

variable "rotation_days" {
  description = "Automatic rotation interval in days. Only applied when rotation_lambda_arn is set."
  type        = number
  default     = 30
  validation {
    condition     = var.rotation_days >= 1 && var.rotation_days <= 365
    error_message = "rotation_days must be between 1 and 365."
  }
}

variable "recovery_window_days" {
  description = "Number of days before a deleted secret is purged. Set to 0 to force-delete (non-recoverable)."
  type        = number
  default     = 7
  validation {
    condition     = var.recovery_window_days == 0 || (var.recovery_window_days >= 7 && var.recovery_window_days <= 30)
    error_message = "recovery_window_days must be 0 (force delete) or 7–30."
  }
}

variable "allowed_principal_arns" {
  description = "List of IAM principal ARNs (roles, users) allowed to read secrets in this environment."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Additional tags applied to all secrets."
  type        = map(string)
  default     = {}
}
