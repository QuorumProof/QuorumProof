# Storage module — versioned, encrypted, private S3 bucket with optional
# cross-region replication (CRR) to a bucket in the secondary region (#1650).
# Used for backups (scripts/backup.sh), exported state snapshots and
# credential metadata blobs that must survive a regional outage.

resource "aws_s3_bucket" "this" {
  bucket        = var.bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Versioning is required on both source and destination for replication.
resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "tls_only" {
  bucket = aws_s3_bucket.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# ── Cross-region replication ─────────────────────────────────────────────────

locals {
  replicate = var.replication_destination_bucket_arn != null
}

data "aws_iam_policy_document" "replication_assume" {
  count = local.replicate ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "replication" {
  count = local.replicate ? 1 : 0

  name               = "${var.bucket_name}-crr"
  assume_role_policy = data.aws_iam_policy_document.replication_assume[0].json
}

data "aws_iam_policy_document" "replication" {
  count = local.replicate ? 1 : 0

  statement {
    actions   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
    resources = [aws_s3_bucket.this.arn]
  }

  statement {
    actions = [
      "s3:GetObjectVersionForReplication",
      "s3:GetObjectVersionAcl",
      "s3:GetObjectVersionTagging",
    ]
    resources = ["${aws_s3_bucket.this.arn}/*"]
  }

  statement {
    actions = [
      "s3:ReplicateObject",
      "s3:ReplicateDelete",
      "s3:ReplicateTags",
    ]
    resources = ["${var.replication_destination_bucket_arn}/*"]
  }

  dynamic "statement" {
    for_each = var.kms_key_arn == null ? [] : [1]
    content {
      actions   = ["kms:Decrypt"]
      resources = [var.kms_key_arn]
    }
  }

  dynamic "statement" {
    for_each = var.replication_destination_kms_key_arn == null ? [] : [1]
    content {
      actions   = ["kms:Encrypt"]
      resources = [var.replication_destination_kms_key_arn]
    }
  }
}

resource "aws_iam_role_policy" "replication" {
  count = local.replicate ? 1 : 0

  name   = "s3-crr"
  role   = aws_iam_role.replication[0].id
  policy = data.aws_iam_policy_document.replication[0].json
}

resource "aws_s3_bucket_replication_configuration" "this" {
  count = local.replicate ? 1 : 0

  bucket = aws_s3_bucket.this.id
  role   = aws_iam_role.replication[0].arn

  rule {
    id     = "replicate-all-to-secondary"
    status = "Enabled"
    filter {}

    delete_marker_replication {
      status = "Enabled"
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = var.kms_key_arn == null ? "Disabled" : "Enabled"
      }
    }

    destination {
      bucket        = var.replication_destination_bucket_arn
      storage_class = "STANDARD"

      dynamic "encryption_configuration" {
        for_each = var.replication_destination_kms_key_arn == null ? [] : [1]
        content {
          replica_kms_key_id = var.replication_destination_kms_key_arn
        }
      }

      # S3 Replication Time Control: 99.99% of objects replicated within
      # 15 minutes, with metrics so lag is observable.
      replication_time {
        status = "Enabled"
        time {
          minutes = 15
        }
      }

      metrics {
        status = "Enabled"
        event_threshold {
          minutes = 15
        }
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}
