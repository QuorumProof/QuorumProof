output "bucket_id" {
  description = "Bucket name."
  value       = aws_s3_bucket.this.id
}

output "bucket_arn" {
  description = "Bucket ARN."
  value       = aws_s3_bucket.this.arn
}

output "replication_enabled" {
  description = "Whether cross-region replication is configured on this bucket."
  value       = local.replicate
}
