output "bucket_id" {
  description = "Archive bucket name."
  value       = aws_s3_bucket.archive.id
}

output "bucket_arn" {
  description = "Archive bucket ARN."
  value       = aws_s3_bucket.archive.arn
}

output "firehose_arn" {
  description = "Firehose delivery stream ARN."
  value       = aws_kinesis_firehose_delivery_stream.logs.arn
}

output "athena_workgroup" {
  description = "Athena workgroup for querying restored logs."
  value       = aws_athena_workgroup.logs.name
}

output "glue_database" {
  description = "Glue database for archive tables."
  value       = aws_glue_catalog_database.logs.name
}
