output "alb_dns_name" {
  description = "DNS name of the api-server ALB."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone ID of the ALB (for Route 53 alias records)."
  value       = aws_lb.this.zone_id
}

output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.api.name
}

output "task_security_group_id" {
  description = "Security group of the api-server tasks (grant this access to the database)."
  value       = aws_security_group.task.id
}

output "log_group_name" {
  description = "CloudWatch log group receiving api-server logs."
  value       = aws_cloudwatch_log_group.api.name
}

output "log_group_arn" {
  description = "CloudWatch log group ARN."
  value       = aws_cloudwatch_log_group.api.arn
}
