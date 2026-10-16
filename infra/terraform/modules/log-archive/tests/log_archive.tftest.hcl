mock_provider "aws" {
  override_data {
    target = data.aws_region.current
    values = { name = "us-east-1" }
  }

  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
}

variables {
  name                   = "qp-test"
  bucket_name            = "qp-test-logs"
  source_log_group_names = ["/quorumproof/qp-test/api-server"]
}

run "default_tiering_and_retention" {
  command = plan

  assert {
    condition = [for t in aws_s3_bucket_lifecycle_configuration.archive.rule[0].transition : t.storage_class] == [
      "STANDARD_IA", "GLACIER_IR", "DEEP_ARCHIVE",
    ]
    error_message = "archive must tier STANDARD_IA → GLACIER_IR → DEEP_ARCHIVE"
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.archive.rule[0].expiration[0].days == 2555
    error_message = "default retention must be 7 years"
  }

  assert {
    condition     = length(aws_s3_bucket_object_lock_configuration.archive) == 1
    error_message = "object lock must be on by default"
  }

  assert {
    condition     = length(aws_cloudwatch_log_subscription_filter.archive) == 1
    error_message = "each source log group needs a subscription filter"
  }
}

run "object_lock_can_be_disabled" {
  command = plan

  variables {
    object_lock_mode = null
  }

  assert {
    condition     = length(aws_s3_bucket_object_lock_configuration.archive) == 0
    error_message = "object lock must be absent when object_lock_mode is null"
  }
}

run "rejects_short_retention" {
  command = plan

  variables {
    expire_after_days = 30
  }

  expect_failures = [var.expire_after_days]
}
