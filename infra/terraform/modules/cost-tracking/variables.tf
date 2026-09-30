# infra/terraform/modules/cost-tracking/variables.tf
# Issue #1657: Cost tracking via AWS Cost Allocation Tags.

variable "project" {
  description = "Project name applied as a cost allocation tag to all resources."
  type        = string
  default     = "quorumproof"
}

variable "environment" {
  description = "Deployment environment (staging, production)."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "team" {
  description = "Owning team for the resources being tagged."
  type        = string
  default     = "platform"
}

variable "cost_center" {
  description = "Cost center or budget code for charge-back."
  type        = string
  default     = ""
}

variable "aws_region" {
  description = "AWS region for Cost Explorer and Budgets resources."
  type        = string
  default     = "us-east-1"
}

variable "monthly_budget_usd" {
  description = "Monthly budget threshold in USD. An alert fires when 80% is reached."
  type        = number
  default     = 500

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd must be positive."
  }
}

variable "budget_alert_email" {
  description = "Email address to notify when budget threshold is breached."
  type        = string
  default     = ""
}

variable "enable_cost_anomaly_detection" {
  description = "Whether to enable AWS Cost Anomaly Detection for this project."
  type        = bool
  default     = true
}
