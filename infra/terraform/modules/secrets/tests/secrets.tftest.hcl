# infra/terraform/modules/secrets/tests/secrets.tftest.hcl
# Issue #1656: Terraform native tests for the secrets module.

variables {
  environment = "staging"
  project     = "quorumproof"
}

run "plan_secrets_created" {
  command = plan

  assert {
    condition     = aws_secretsmanager_secret.stellar_deploy_key.name == "quorumproof/staging/stellar/deploy-key"
    error_message = "Stellar deploy key must follow <project>/<env>/stellar/deploy-key path."
  }

  assert {
    condition     = aws_secretsmanager_secret.database_url.name == "quorumproof/staging/database/url"
    error_message = "Database URL secret must follow <project>/<env>/database/url path."
  }

  assert {
    condition     = aws_secretsmanager_secret.api_jwt_secret.name == "quorumproof/staging/api-server/jwt-secret"
    error_message = "JWT secret must follow <project>/<env>/api-server/jwt-secret path."
  }

  assert {
    condition     = aws_secretsmanager_secret.webhook_signing_key.name == "quorumproof/staging/api-server/webhook-signing-key"
    error_message = "Webhook signing key must follow <project>/<env>/api-server/webhook-signing-key path."
  }
}

run "plan_rotation_disabled_by_default" {
  command = plan

  assert {
    condition     = length(aws_secretsmanager_secret_rotation.stellar_deploy_key) == 0
    error_message = "Rotation should be disabled when rotation_lambda_arn is not set."
  }

  assert {
    condition     = length(aws_secretsmanager_secret_rotation.database_url) == 0
    error_message = "Rotation should be disabled when rotation_lambda_arn is not set."
  }
}

run "plan_rotation_enabled" {
  command = plan

  variables {
    rotation_lambda_arn = "arn:aws:lambda:us-east-1:123456789012:function:secret-rotator"
    rotation_days       = 30
  }

  assert {
    condition     = length(aws_secretsmanager_secret_rotation.stellar_deploy_key) == 1
    error_message = "Rotation should be enabled when rotation_lambda_arn is set."
  }

  assert {
    condition     = aws_secretsmanager_secret_rotation.stellar_deploy_key[0].rotation_rules[0].automatically_after_days == 30
    error_message = "Rotation interval must match rotation_days variable."
  }
}

run "plan_no_access_policy_without_principals" {
  command = plan

  assert {
    condition     = length(aws_secretsmanager_secret_policy.stellar_deploy_key) == 0
    error_message = "Access policy should NOT be created when allowed_principal_arns is empty."
  }
}

run "plan_access_policy_with_principals" {
  command = plan

  variables {
    allowed_principal_arns = ["arn:aws:iam::123456789012:role/quorumproof-ecs-task"]
  }

  assert {
    condition     = length(aws_secretsmanager_secret_policy.stellar_deploy_key) == 1
    error_message = "Access policy should be created when principals are specified."
  }
}
