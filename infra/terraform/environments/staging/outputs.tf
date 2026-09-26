output "alb_dns_name" {
  description = "Staging api-server ALB."
  value       = module.compute.alb_dns_name
}

output "db_writer_endpoint" {
  description = "Aurora writer endpoint."
  value       = module.database.writer_endpoint
}

output "log_archive_bucket" {
  description = "Log archive bucket."
  value       = module.log_archive.bucket_id
}
