# infra/terraform/modules/secrets/outputs.tf
# Issue #1656

output "stellar_deploy_key_arn" {
  description = "ARN of the Stellar deploy key secret."
  value       = aws_secretsmanager_secret.stellar_deploy_key.arn
}

output "database_url_arn" {
  description = "ARN of the database URL secret."
  value       = aws_secretsmanager_secret.database_url.arn
}

output "api_jwt_secret_arn" {
  description = "ARN of the API JWT signing secret."
  value       = aws_secretsmanager_secret.api_jwt_secret.arn
}

output "webhook_signing_key_arn" {
  description = "ARN of the webhook signing key secret."
  value       = aws_secretsmanager_secret.webhook_signing_key.arn
}

output "pagerduty_routing_key_arn" {
  description = "ARN of the PagerDuty routing key secret."
  value       = aws_secretsmanager_secret.pagerduty_routing_key.arn
}

output "slack_webhook_url_arn" {
  description = "ARN of the Slack webhook URL secret."
  value       = aws_secretsmanager_secret.slack_webhook_url.arn
}

output "secret_arns" {
  description = "Map of secret name to ARN for all secrets managed by this module."
  value = {
    stellar_deploy_key   = aws_secretsmanager_secret.stellar_deploy_key.arn
    database_url         = aws_secretsmanager_secret.database_url.arn
    api_jwt_secret       = aws_secretsmanager_secret.api_jwt_secret.arn
    webhook_signing_key  = aws_secretsmanager_secret.webhook_signing_key.arn
    pagerduty_routing_key = aws_secretsmanager_secret.pagerduty_routing_key.arn
    slack_webhook_url    = aws_secretsmanager_secret.slack_webhook_url.arn
  }
}
