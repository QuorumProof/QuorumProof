variable "name" {
  description = "Name prefix."
  type        = string
}

variable "vpc_id" {
  description = "VPC to deploy into."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets for the DB subnet group."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to connect on 5432 (the api-server tasks)."
  type        = list(string)
}

variable "engine_version" {
  description = "Aurora PostgreSQL engine version (must be identical across global cluster members)."
  type        = string
  default     = "15.5"
}

variable "database_name" {
  description = "Initial database name (primary only)."
  type        = string
  default     = "quorumproof"
}

variable "master_username" {
  description = "Master username (primary only; password is managed in Secrets Manager)."
  type        = string
  default     = "quorumproof_admin"
}

variable "instance_class" {
  description = "Aurora instance class."
  type        = string
  default     = "db.r6g.large"
}

variable "instance_count" {
  description = "Instances in this regional cluster (writer + readers)."
  type        = number
  default     = 2
}

variable "global_cluster_identifier" {
  description = "Aurora global cluster id. null = standalone regional cluster."
  type        = string
  default     = null
}

variable "is_secondary" {
  description = "Join the global cluster as a read-only secondary."
  type        = bool
  default     = false

  validation {
    condition     = !var.is_secondary || var.kms_key_arn != null
    error_message = "A secondary (cross-region) encrypted cluster requires an explicit kms_key_arn in its own region."
  }
}

variable "kms_key_arn" {
  description = "KMS key for storage encryption (required for cross-region secondaries)."
  type        = string
  default     = null
}

variable "backup_retention_days" {
  description = "Automated backup / point-in-time recovery retention window in days (1–35). Must be set explicitly per environment."
  type        = number

  validation {
    condition     = var.backup_retention_days != null ? (var.backup_retention_days >= 1 && var.backup_retention_days <= 35) : false
    error_message = "backup_retention_days must be set explicitly to a value between 1 and 35 days."
  }
}

variable "preferred_backup_window" {
  description = "Daily UTC time range for automated backups (HH:MM-HH:MM). Must be set explicitly per environment."
  type        = string

  validation {
    condition     = var.preferred_backup_window != null ? can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$", var.preferred_backup_window)) : false
    error_message = "preferred_backup_window must be set explicitly in HH:MM-HH:MM UTC format."
  }
}

variable "preferred_maintenance_window" {
  description = "Weekly UTC maintenance window (ddd:HH:MM-ddd:HH:MM). Must be set explicitly per environment."
  type        = string

  validation {
    condition     = var.preferred_maintenance_window != null ? can(regex("^(mon|tue|wed|thu|fri|sat|sun):([01][0-9]|2[0-3]):[0-5][0-9]-(mon|tue|wed|thu|fri|sat|sun):([01][0-9]|2[0-3]):[0-5][0-9]$", var.preferred_maintenance_window)) : false
    error_message = "preferred_maintenance_window must be set explicitly in ddd:HH:MM-ddd:HH:MM UTC format."
  }
}

variable "deletion_protection" {
  description = "Prevent accidental cluster deletion. Must be set explicitly per environment."
  type        = bool

  validation {
    condition     = var.deletion_protection != null
    error_message = "deletion_protection must be set explicitly for every environment."
  }
}

variable "replication_lag_alarm_ms" {
  description = "Alarm threshold for global replication lag (secondary only)."
  type        = number
  default     = 5000
}

variable "alarm_sns_topic_arns" {
  description = "SNS topics notified by database alarms."
  type        = list(string)
  default     = []
}
