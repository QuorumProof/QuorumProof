mock_provider "aws" {}

variables {
  bucket_name = "qp-test-bucket"
}

run "no_replication_by_default" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_replication_configuration.this) == 0
    error_message = "replication must be off when no destination is given"
  }

  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Enabled"
    error_message = "versioning must always be enabled"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.this.block_public_acls && aws_s3_bucket_public_access_block.this.restrict_public_buckets
    error_message = "bucket must block public access"
  }
}

run "cross_region_replication" {
  command = plan

  variables {
    replication_destination_bucket_arn = "arn:aws:s3:::qp-test-bucket-replica"
  }

  assert {
    condition     = length(aws_s3_bucket_replication_configuration.this) == 1
    error_message = "replication configuration expected when destination is set"
  }

  assert {
    condition     = aws_s3_bucket_replication_configuration.this[0].rule[0].destination[0].replication_time[0].time[0].minutes == 15
    error_message = "replication time control must be 15 minutes"
  }
}
