variable "bucket_name" {
  description = "Globally unique bucket name."
  type        = string
}

variable "kms_key_arn" {
  description = "Optional KMS key for SSE-KMS (null = SSE-S3)."
  type        = string
  default     = null
}

variable "noncurrent_version_expiration_days" {
  description = "Days to keep non-current object versions."
  type        = number
  default     = 90
}

variable "replication_destination_bucket_arn" {
  description = "Destination bucket ARN in the secondary region. null disables CRR."
  type        = string
  default     = null
}

variable "replication_destination_kms_key_arn" {
  description = "KMS key in the destination region used to re-encrypt replicas."
  type        = string
  default     = null
}
