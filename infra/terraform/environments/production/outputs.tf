output "api_fqdn" {
  description = "Failover-routed public API hostname."
  value       = module.failover.api_fqdn
}

output "regions" {
  description = "Per-region endpoints and resources, consumed by scripts/region_failover.sh."
  value = {
    primary = {
      region            = var.primary_region
      alb_dns_name      = module.compute_primary.alb_dns_name
      ecs_cluster       = module.compute_primary.cluster_name
      ecs_service       = module.compute_primary.service_name
      db_cluster        = module.database_primary.cluster_identifier
      data_bucket       = module.storage_primary.bucket_id
      log_archive       = module.log_archive_primary.bucket_id
      athena_workgroup  = module.log_archive_primary.athena_workgroup
      health_check_fqdn = "api-${var.primary_region}.${var.api_domain}"
    }
    secondary = {
      region            = var.secondary_region
      alb_dns_name      = module.compute_secondary.alb_dns_name
      ecs_cluster       = module.compute_secondary.cluster_name
      ecs_service       = module.compute_secondary.service_name
      db_cluster        = module.database_secondary.cluster_identifier
      data_bucket       = module.storage_secondary.bucket_id
      log_archive       = module.log_archive_secondary.bucket_id
      athena_workgroup  = module.log_archive_secondary.athena_workgroup
      health_check_fqdn = "api-${var.secondary_region}.${var.api_domain}"
    }
  }
}

output "global_db_cluster" {
  description = "Aurora global cluster identifier."
  value       = module.database_primary.global_cluster_identifier
}

output "health_check_ids" {
  description = "Route 53 health check ids by region."
  value       = module.failover.health_check_ids
}

output "failover_sns_topic_arn" {
  description = "SNS topic for failover alerts."
  value       = module.failover.sns_topic_arn
}
