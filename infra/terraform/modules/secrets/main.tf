# infra/terraform/modules/secrets/main.tf
# Issue #1656: Secrets management — AWS Secrets Manager with Vault-compatible
# secret paths, automatic rotation, and resource-based access policies.
#
# This module manages the lifecycle of all QuorumProof secrets:
#
#   quorumproof/<environment>/stellar/deploy-key
#   quorumproof/<environment>/database/url
#   quorumproof/<environment>/api-server/jwt-secret
#   quorumproof/<environment>/api-server/webhook-signing-key
#   quorumproof/<environment>/monitoring/pagerduty-routing-key
#   quorumproof/<environment>/monitoring/slack-webhook-url
#
# Vault-compatible naming: the path structure mirrors HashiCorp Vault's KV-v2
# path convention (`<project>/<environment>/<service>/<key>`) so that a future
# migration from Secrets Manager to a self-hosted Vault cluster requires only
# path remapping, not application changes.
#
# Usage (in environments/production/main.tf):
#   module "secrets" {
#     source                 = "../../modules/secrets"
#     environment            = var.environment
#     kms_key_arn            = module.kms.key_arn
#     rotation_lambda_arn    = module.rotation_lambda.arn
#     allowed_principal_arns = [module.ecs_task_role.arn]
#   }

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

locals {
  prefix = "${var.project}/${var.environment}"

  common_tags = merge({
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
    SecretModule = "quorumproof-secrets-v1"
  }, var.tags)

  rotation_enabled = var.rotation_lambda_arn != ""
  kms_key          = var.kms_key_arn != "" ? var.kms_key_arn : null
}

# ── Stellar deploy key ─────────────────────────────────────────────────────────
resource "aws_secretsmanager_secret" "stellar_deploy_key" {
  name                    = "${local.prefix}/stellar/deploy-key"
  description             = "Stellar account secret key used for contract deployments (${var.environment})."
  kms_key_id              = local.kms_key
  recovery_window_in_days = var.recovery_window_days

  tags = merge(local.common_tags, {
    Component = "stellar"
    SecretType = "credentials"
    RotationSupported = tostring(local.rotation_enabled)
  })
}

resource "aws_secretsmanager_secret_rotation" "stellar_deploy_key" {
  count = local.rotation_enabled ? 1 : 0

  secret_id           = aws_secretsmanager_secret.stellar_deploy_key.id
  rotation_lambda_arn = var.rotation_lambda_arn

  rotation_rules {
    automatically_after_days = var.rotation_days
  }
}

# ── Database URL ──────────────────────────────────────────────────────────────
resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${local.prefix}/database/url"
  description             = "PostgreSQL connection URL for the QuorumProof API server (${var.environment})."
  kms_key_id              = local.kms_key
  recovery_window_in_days = var.recovery_window_days

  tags = merge(local.common_tags, {
    Component  = "database"
    SecretType = "connection-string"
    RotationSupported = tostring(local.rotation_enabled)
  })
}

resource "aws_secretsmanager_secret_rotation" "database_url" {
  count = local.rotation_enabled ? 1 : 0

  secret_id           = aws_secretsmanager_secret.database_url.id
  rotation_lambda_arn = var.rotation_lambda_arn

  rotation_rules {
    automatically_after_days = var.rotation_days
  }
}

# ── API server JWT secret ──────────────────────────────────────────────────────
resource "aws_secretsmanager_secret" "api_jwt_secret" {
  name                    = "${local.prefix}/api-server/jwt-secret"
  description             = "HS256 JWT signing secret for the QuorumProof API server (${var.environment})."
  kms_key_id              = local.kms_key
  recovery_window_in_days = var.recovery_window_days

  tags = merge(local.common_tags, {
    Component  = "api-server"
    SecretType = "signing-key"
    RotationSupported = tostring(local.rotation_enabled)
  })
}

resource "aws_secretsmanager_secret_rotation" "api_jwt_secret" {
  count = local.rotation_enabled ? 1 : 0

  secret_id           = aws_secretsmanager_secret.api_jwt_secret.id
  rotation_lambda_arn = var.rotation_lambda_arn

  rotation_rules {
    automatically_after_days = var.rotation_days
  }
}

# ── Webhook signing key ────────────────────────────────────────────────────────
resource "aws_secretsmanager_secret" "webhook_signing_key" {
  name                    = "${local.prefix}/api-server/webhook-signing-key"
  description             = "HMAC-SHA256 key for signing outbound webhook payloads (${var.environment})."
  kms_key_id              = local.kms_key
  recovery_window_in_days = var.recovery_window_days

  tags = merge(local.common_tags, {
    Component  = "api-server"
    SecretType = "signing-key"
  })
}

# ── PagerDuty routing key ──────────────────────────────────────────────────────
resource "aws_secretsmanager_secret" "pagerduty_routing_key" {
  name                    = "${local.prefix}/monitoring/pagerduty-routing-key"
  description             = "PagerDuty Events API v2 routing key for critical alerts (${var.environment})."
  kms_key_id              = local.kms_key
  recovery_window_in_days = var.recovery_window_days

  tags = merge(local.common_tags, {
    Component  = "monitoring"
    SecretType = "api-key"
  })
}

# ── Slack webhook URL ─────────────────────────────────────────────────────────
resource "aws_secretsmanager_secret" "slack_webhook_url" {
  name                    = "${local.prefix}/monitoring/slack-webhook-url"
  description             = "Slack incoming webhook URL for deployment and alert notifications (${var.environment})."
  kms_key_id              = local.kms_key
  recovery_window_in_days = var.recovery_window_days

  tags = merge(local.common_tags, {
    Component  = "monitoring"
    SecretType = "webhook-url"
  })
}

# ── Resource-based access policy ──────────────────────────────────────────────
# Grants the listed principals read-only access to all secrets in this module.
# This policy is applied to each secret individually, giving fine-grained
# per-secret audit trail in CloudTrail.
data "aws_iam_policy_document" "secret_read" {
  count = length(var.allowed_principal_arns) > 0 ? 1 : 0

  statement {
    sid    = "AllowSecretRead"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = var.allowed_principal_arns
    }

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = ["*"]
  }
}

resource "aws_secretsmanager_secret_policy" "stellar_deploy_key" {
  count = length(var.allowed_principal_arns) > 0 ? 1 : 0

  secret_arn = aws_secretsmanager_secret.stellar_deploy_key.arn
  policy     = data.aws_iam_policy_document.secret_read[0].json
}

resource "aws_secretsmanager_secret_policy" "database_url" {
  count = length(var.allowed_principal_arns) > 0 ? 1 : 0

  secret_arn = aws_secretsmanager_secret.database_url.arn
  policy     = data.aws_iam_policy_document.secret_read[0].json
}

resource "aws_secretsmanager_secret_policy" "api_jwt_secret" {
  count = length(var.allowed_principal_arns) > 0 ? 1 : 0

  secret_arn = aws_secretsmanager_secret.api_jwt_secret.arn
  policy     = data.aws_iam_policy_document.secret_read[0].json
}

resource "aws_secretsmanager_secret_policy" "webhook_signing_key" {
  count = length(var.allowed_principal_arns) > 0 ? 1 : 0

  secret_arn = aws_secretsmanager_secret.webhook_signing_key.arn
  policy     = data.aws_iam_policy_document.secret_read[0].json
}
