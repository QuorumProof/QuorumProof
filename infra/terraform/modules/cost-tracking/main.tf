# infra/terraform/modules/cost-tracking/main.tf
# Issue #1657: Cost tracking — AWS Cost Allocation Tags, Budgets, and
# Anomaly Detection for QuorumProof infrastructure resources.
#
# This module does not create EC2/ECS/RDS resources directly; it creates the
# governance layer (budget alerts, anomaly monitors, tag policies) that makes
# costs visible and controllable across all QuorumProof resources.
#
# Usage: add to environments/production/main.tf:
#   module "cost_tracking" {
#     source              = "../../modules/cost-tracking"
#     environment         = var.environment
#     monthly_budget_usd  = 500
#     budget_alert_email  = var.ops_email
#   }

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# ── Local cost allocation tags ─────────────────────────────────────────────────
# These tags are applied to every taggable resource created by other modules
# when they pass `var.default_tags` from the root module. They are also used
# by the Budget filter to scope cost tracking to this project.
locals {
  default_tags = {
    Project     = var.project
    Environment = var.environment
    Team        = var.team
    CostCenter  = var.cost_center != "" ? var.cost_center : "${var.project}-${var.environment}"
    ManagedBy   = "terraform"
  }
}

# ── AWS Budgets ────────────────────────────────────────────────────────────────
# Monthly budget scoped to resources tagged with Project=<project> and
# Environment=<environment>. Sends an alert at 80% and 100% of threshold.
resource "aws_budgets_budget" "monthly" {
  name         = "${var.project}-${var.environment}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Filter to only resources tagged for this project+environment
  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$${var.project}"]
  }

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Environment$${var.environment}"]
  }

  # Alert at 80% (early warning)
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_alert_email != "" ? [var.budget_alert_email] : []
  }

  # Alert at 100% (budget breached)
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_alert_email != "" ? [var.budget_alert_email] : []
  }
}

# ── AWS Cost Anomaly Detection ─────────────────────────────────────────────────
# Monitors spend patterns for this project and alerts on statistically
# anomalous cost spikes (e.g., a misconfigured loop causing 10x normal spend).
resource "aws_ce_anomaly_monitor" "project" {
  count = var.enable_cost_anomaly_detection ? 1 : 0

  name              = "${var.project}-${var.environment}-anomaly-monitor"
  monitor_type      = "CUSTOM"

  monitor_specification = jsonencode({
    And = null
    Not = null
    Or  = null
    CostCategories = null
    Dimensions     = null
    Tags = {
      Key    = "Project"
      Values = [var.project]
      MatchOptions = ["EQUALS"]
    }
  })
}

resource "aws_ce_anomaly_subscription" "project" {
  count = var.enable_cost_anomaly_detection && var.budget_alert_email != "" ? 1 : 0

  name      = "${var.project}-${var.environment}-anomaly-subscription"
  frequency = "DAILY"

  monitor_arn_list = [
    aws_ce_anomaly_monitor.project[0].arn
  ]

  subscriber {
    type    = "EMAIL"
    address = var.budget_alert_email
  }

  # Alert only on anomalies with > $20 impact to reduce noise
  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      values        = ["20"]
      match_options = ["GREATER_THAN_OR_EQUAL"]
    }
  }
}

# ── Cost Allocation Tag activation ────────────────────────────────────────────
# Activates the user-defined cost allocation tags so they appear in Cost Explorer.
# Requires aws:CostExplorer:UpdateCostAllocationTagsStatus permission.
resource "aws_ce_cost_allocation_tag" "project_tag" {
  tag_key = "Project"
  status  = "Active"
}

resource "aws_ce_cost_allocation_tag" "environment_tag" {
  tag_key = "Environment"
  status  = "Active"
}

resource "aws_ce_cost_allocation_tag" "team_tag" {
  tag_key = "Team"
  status  = "Active"
}

resource "aws_ce_cost_allocation_tag" "component_tag" {
  tag_key = "Component"
  status  = "Active"
}

resource "aws_ce_cost_allocation_tag" "cost_center_tag" {
  tag_key = "CostCenter"
  status  = "Active"
}
