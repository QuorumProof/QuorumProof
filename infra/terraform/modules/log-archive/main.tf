# Log archive module — retention policy + cold-storage archival (#1653).
#
# Tiering (defaults; see docs/log-retention-policy.md for the rationale):
#
#   0 – 30 d    hot    CloudWatch Logs / Loki (queryable, set by callers)
#   0 – 30 d    S3 STANDARD            (archive copy, immediately retrievable)
#   30 – 90 d   S3 STANDARD_IA
#   90 – 365 d  S3 GLACIER_IR          (millisecond retrieval)
#   365 d +     S3 DEEP_ARCHIVE        (12 h retrieval, ~$1/TB-month)
#   2555 d      expired (7 years)      unless under legal hold
#
# CloudWatch log groups passed in `source_log_group_names` are streamed to the
# bucket through a Kinesis Data Firehose delivery stream (gzip, partitioned by
# date). Loki ships its own chunks to the same bucket under `loki/` via its S3
# object store config (monitoring/loki/loki.yml).

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_s3_bucket" "archive" {
  bucket              = var.bucket_name
  object_lock_enabled = var.object_lock_mode != null
  force_destroy       = false
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket                  = aws_s3_bucket.archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "archive" {
  bucket = aws_s3_bucket.archive.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}

# WORM protection so archived audit logs cannot be altered or deleted before
# the minimum retention elapses (SOC 2 CC7.2 / ISO 27001 A.12.4.2).
resource "aws_s3_bucket_object_lock_configuration" "archive" {
  count = var.object_lock_mode == null ? 0 : 1

  bucket = aws_s3_bucket.archive.id

  rule {
    default_retention {
      mode = var.object_lock_mode
      days = var.object_lock_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.archive]
}

resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    id     = "log-retention-tiering"
    status = "Enabled"
    filter {}

    transition {
      days          = var.standard_ia_after_days
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = var.glacier_ir_after_days
      storage_class = "GLACIER_IR"
    }

    transition {
      days          = var.deep_archive_after_days
      storage_class = "DEEP_ARCHIVE"
    }

    expiration {
      days = var.expire_after_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 3
    }
  }

  depends_on = [aws_s3_bucket_versioning.archive]
}

resource "aws_s3_bucket_policy" "archive" {
  bucket = aws_s3_bucket.archive.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        # Only the lifecycle policy may delete archived logs.
        Sid       = "DenyManualDelete"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource  = "${aws_s3_bucket.archive.arn}/*"
        Condition = {
          StringNotLike = { "aws:PrincipalArn" = var.break_glass_principal_arns }
        }
      },
    ]
  })
}

# ── CloudWatch Logs → Firehose → S3 ─────────────────────────────────────────

resource "aws_iam_role" "firehose" {
  name = "${var.name}-log-archive-firehose"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "firehose.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "sts:ExternalId" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "firehose" {
  name = "write-archive"
  role = aws_iam_role.firehose.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:GetBucketLocation",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:ListBucketMultipartUploads",
          "s3:PutObject",
        ]
        Resource = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]
      }],
      var.kms_key_arn == null ? [] : [{
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = [var.kms_key_arn]
      }],
    )
  })
}

resource "aws_kinesis_firehose_delivery_stream" "logs" {
  name        = "${var.name}-log-archive"
  destination = "extended_s3"

  server_side_encryption {
    enabled  = true
    key_type = "AWS_OWNED_CMK"
  }

  extended_s3_configuration {
    role_arn            = aws_iam_role.firehose.arn
    bucket_arn          = aws_s3_bucket.archive.arn
    prefix              = "cloudwatch/!{timestamp:yyyy}/!{timestamp:MM}/!{timestamp:dd}/"
    error_output_prefix = "cloudwatch-errors/!{firehose:error-output-type}/!{timestamp:yyyy}/!{timestamp:MM}/!{timestamp:dd}/"
    buffering_size      = 64
    buffering_interval  = 300
    # CloudWatch subscription payloads are already gzip-compressed.
    compression_format = "UNCOMPRESSED"
    kms_key_arn        = var.kms_key_arn
  }
}

resource "aws_iam_role" "cwl_to_firehose" {
  name = "${var.name}-cwl-to-firehose"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "logs.${data.aws_region.current.name}.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringLike = { "aws:SourceArn" = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "cwl_to_firehose" {
  name = "put-firehose"
  role = aws_iam_role.cwl_to_firehose.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["firehose:PutRecord", "firehose:PutRecordBatch"]
      Resource = aws_kinesis_firehose_delivery_stream.logs.arn
    }]
  })
}

resource "aws_cloudwatch_log_subscription_filter" "archive" {
  for_each = toset(var.source_log_group_names)

  name            = "${var.name}-archive"
  log_group_name  = each.value
  filter_pattern  = ""
  destination_arn = aws_kinesis_firehose_delivery_stream.logs.arn
  role_arn        = aws_iam_role.cwl_to_firehose.arn
}

# ── Retrieval (#1653) ────────────────────────────────────────────────────────
# Athena workgroup + Glue table over the archive so restored logs can be
# queried with SQL. See scripts/log_retrieve.sh.

resource "aws_glue_catalog_database" "logs" {
  name = replace("${var.name}_log_archive", "-", "_")
}

resource "aws_athena_workgroup" "logs" {
  name          = "${var.name}-log-archive"
  force_destroy = false

  configuration {
    enforce_workgroup_configuration = true

    result_configuration {
      output_location = "s3://${aws_s3_bucket.archive.id}/athena-results/"

      encryption_configuration {
        encryption_option = var.kms_key_arn == null ? "SSE_S3" : "SSE_KMS"
        kms_key_arn       = var.kms_key_arn
      }
    }
  }
}
