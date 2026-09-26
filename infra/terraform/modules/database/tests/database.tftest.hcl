mock_provider "aws" {}

variables {
  name                       = "qp-test"
  vpc_id                     = "vpc-123"
  private_subnet_ids         = ["subnet-a", "subnet-b"]
  allowed_security_group_ids = ["sg-123"]
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
