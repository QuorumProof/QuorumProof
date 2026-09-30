# infra/terraform/modules/cost-tracking/outputs.tf
# Issue #1657

output "default_tags" {
  description = "Map of cost allocation tags to apply to all resources in this environment."
  value = {
    Project     = var.project
    Environment = var.environment
    Team        = var.team
    CostCenter  = var.cost_center != "" ? var.cost_center : "${var.project}-${var.environment}"
    ManagedBy   = "terraform"
  }
}

output "budget_name" {
  description = "Name of the AWS Budget created for this environment."
  value       = aws_budgets_budget.monthly.name
}

output "anomaly_monitor_arn" {
  description = "ARN of the Cost Anomaly Monitor (empty if anomaly detection disabled)."
  value       = var.enable_cost_anomaly_detection ? aws_ce_anomaly_monitor.project[0].arn : ""
}
