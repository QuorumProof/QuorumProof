output "health_check_ids" {
  description = "Map of region key → Route 53 health check id."
  value       = { for k, v in aws_route53_health_check.region : k => v.id }
}

output "sns_topic_arn" {
  description = "SNS topic receiving failover alerts."
  value       = aws_sns_topic.failover.arn
}

output "api_fqdn" {
  description = "Failover-routed API hostname."
  value       = var.record_name
}
