mock_provider "aws" {}

variables {
  name                         = "qp-test"
  vpc_id                       = "vpc-123"
  private_subnet_ids           = ["subnet-a", "subnet-b"]
  allowed_security_group_ids   = ["sg-123"]
  deletion_protection          = true
  backup_retention_days        = 14
  preferred_backup_window      = "03:00-04:00"
  preferred_maintenance_window = "sun:05:00-sun:06:00"
}

run "primary_creates_global_cluster" {
  command = plan

  variables {
    global_cluster_identifier = "qp-global"
  }

  assert {
    condition     = length(aws_rds_global_cluster.this) == 1
    error_message = "primary must create the global cluster"
  }

  assert {
    condition     = aws_rds_global_cluster.this[0].deletion_protection == true
    error_message = "global cluster must inherit explicit deletion_protection"
  }

  assert {
    condition     = aws_rds_cluster.this.deletion_protection == true
    error_message = "regional cluster must set deletion_protection explicitly"
  }

  assert {
    condition     = aws_rds_cluster.this.backup_retention_period == 14
    error_message = "regional cluster must set backup_retention_period explicitly"
  }

  assert {
    condition     = aws_rds_cluster.this.preferred_backup_window == "03:00-04:00"
    error_message = "regional cluster must set preferred_backup_window explicitly"
  }

  assert {
    condition     = aws_rds_cluster.this.preferred_maintenance_window == "sun:05:00-sun:06:00"
    error_message = "regional cluster must set preferred_maintenance_window explicitly"
  }

  assert {
    condition     = aws_rds_cluster.this.skip_final_snapshot == false
    error_message = "regional cluster must not skip final snapshot"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.replication_lag) == 0
    error_message = "replication lag alarm belongs on the secondary only"
  }
}

run "secondary_joins_global_cluster" {
  command = plan

  variables {
    global_cluster_identifier = "qp-global"
    is_secondary              = true
    kms_key_arn               = "arn:aws:kms:eu-west-1:123456789012:key/mrk-test"
  }

  assert {
    condition     = length(aws_rds_global_cluster.this) == 0
    error_message = "secondary must not create a second global cluster"
  }

  assert {
    condition     = aws_rds_cluster.this.master_username == null
    error_message = "secondary must inherit credentials from the primary"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.replication_lag) == 1
    error_message = "secondary must alarm on replication lag"
  }
}

run "secondary_requires_kms_key" {
  command = plan

  variables {
    global_cluster_identifier = "qp-global"
    is_secondary              = true
  }

  expect_failures = [var.is_secondary]
}

run "rejects_missing_deletion_protection" {
  command = plan

  variables {
    deletion_protection = null
  }

  expect_failures = [var.deletion_protection]
}

run "rejects_missing_backup_retention_days" {
  command = plan

  variables {
    backup_retention_days = null
  }

  expect_failures = [var.backup_retention_days]
}

run "rejects_zero_backup_retention_days" {
  command = plan

  variables {
    backup_retention_days = 0
  }

  expect_failures = [var.backup_retention_days]
}

run "rejects_missing_backup_window" {
  command = plan

  variables {
    preferred_backup_window = null
  }

  expect_failures = [var.preferred_backup_window]
}

run "rejects_missing_maintenance_window" {
  command = plan

  variables {
    preferred_maintenance_window = null
  }

  expect_failures = [var.preferred_maintenance_window]
}
