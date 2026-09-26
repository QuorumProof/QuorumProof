variable "name" {
  description = "Name prefix."
  type        = string
}

variable "bucket_name" {
  description = "Globally unique archive bucket name."
  type        = string
}

variable "kms_key_arn" {
  description = "Optional KMS key for archive encryption."
  type        = string
  default     = null
}

variable "source_log_group_names" {
  description = "CloudWatch log groups streamed into the archive."
  type        = list(string)
  default     = []
}

variable "standard_ia_after_days" {
  description = "Days before archived logs move to STANDARD_IA."
  type        = number
  default     = 30
}

variable "glacier_ir_after_days" {
  description = "Days before archived logs move to GLACIER_IR."
  type        = number
  default     = 90
}

variable "deep_archive_after_days" {
  description = "Days before archived logs move to DEEP_ARCHIVE."
  type        = number
  default     = 365
}

variable "expire_after_days" {
  description = "Days after which archived logs are permanently deleted (default 7 years)."
  type        = number
  default     = 2555

  validation {
    condition     = var.expire_after_days >= 365
    error_message = "Audit logs must be retained for at least 365 days (see docs/log-retention-policy.md)."
  }
}

variable "object_lock_mode" {
  description = "S3 Object Lock mode (GOVERNANCE or COMPLIANCE). null disables WORM. Can only be enabled at bucket creation."
  type        = string
  default     = "GOVERNANCE"

  validation {
    condition     = var.object_lock_mode == null || contains(["GOVERNANCE", "COMPLIANCE"], coalesce(var.object_lock_mode, "x"))
    error_message = "object_lock_mode must be null, GOVERNANCE or COMPLIANCE."
  }
}

variable "object_lock_days" {
  description = "Minimum WORM retention for every archived object."
  type        = number
  default     = 365
}

variable "break_glass_principal_arns" {
  description = "IAM principal ARN patterns allowed to delete archived objects (e.g. for GDPR erasure)."
  type        = list(string)
  default     = ["arn:aws:iam::*:role/quorumproof-break-glass"]

  validation {
    condition     = length(var.break_glass_principal_arns) > 0
    error_message = "At least one break-glass principal pattern is required."
  }
}
