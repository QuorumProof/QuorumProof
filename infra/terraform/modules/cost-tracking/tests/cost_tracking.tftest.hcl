# infra/terraform/modules/cost-tracking/tests/cost_tracking.tftest.hcl
# Issue #1657: Terraform native tests for the cost-tracking module.

variables {
  project            = "quorumproof"
  environment        = "staging"
  team               = "platform"
  monthly_budget_usd = 100
  budget_alert_email = "ops@example.com"
}

# Plan-only: verify resources are planned correctly without applying
run "plan_budget_and_anomaly_detection" {
  command = plan

  assert {
    condition     = aws_budgets_budget.monthly.name == "quorumproof-staging-monthly"
    error_message = "Budget name must follow <project>-<environment>-monthly pattern."
  }

  assert {
    condition     = aws_budgets_budget.monthly.limit_amount == "100"
    error_message = "Budget limit must match monthly_budget_usd variable."
  }

  assert {
    condition     = aws_budgets_budget.monthly.budget_type == "COST"
    error_message = "Budget type must be COST."
  }

  assert {
    condition     = length(aws_ce_anomaly_monitor.project) == 1
    error_message = "Anomaly monitor should be created when enable_cost_anomaly_detection is true (default)."
  }

  assert {
    condition     = length(aws_ce_anomaly_subscription.project) == 1
    error_message = "Anomaly subscription should be created when email is provided."
  }
}

run "plan_disabled_anomaly_detection" {
  command = plan

  variables {
    enable_cost_anomaly_detection = false
  }

  assert {
    condition     = length(aws_ce_anomaly_monitor.project) == 0
    error_message = "Anomaly monitor should NOT be created when anomaly detection is disabled."
  }
}

run "plan_default_tags_output" {
  command = plan

  assert {
    condition     = output.default_tags["Project"] == "quorumproof"
    error_message = "default_tags must include Project tag."
  }

  assert {
    condition     = output.default_tags["Environment"] == "staging"
    error_message = "default_tags must include Environment tag."
  }

  assert {
    condition     = output.default_tags["ManagedBy"] == "terraform"
    error_message = "default_tags must include ManagedBy=terraform."
  }
}
