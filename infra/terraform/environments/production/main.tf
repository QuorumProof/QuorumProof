# Production — active/passive multi-region deployment (#1650, #1652, #1653).
#
#   primary   (us-east-1)  serves all traffic; Aurora writer; S3 source
#   secondary (eu-west-1)  warm standby; Aurora global read replica; S3 CRR target
#
# Route 53 failover records switch api_domain to the secondary when the
# primary's /health/ready health check fails. See docs/multi-region-failover.md.

locals {
  name_primary   = "quorumproof-prod-${replace(var.primary_region, "-", "")}"
  name_secondary = "quorumproof-prod-${replace(var.secondary_region, "-", "")}"
  global_db_id   = "quorumproof-prod-global"
}

data "aws_caller_identity" "current" {
  provider = aws.primary
}

# ── Encryption keys (one multi-region key pair) ──────────────────────────────

resource "aws_kms_key" "primary" {
  provider = aws.primary

  description             = "QuorumProof production data key (multi-region primary)"
  multi_region            = true
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_replica_key" "secondary" {
  provider = aws.secondary

  description             = "QuorumProof production data key (replica)"
  primary_key_arn         = aws_kms_key.primary.arn
  deletion_window_in_days = 30
}

# ── Secrets (resolved per region; secrets are replicated by Secrets Manager) ─

data "aws_secretsmanager_secret" "primary" {
  provider = aws.primary
  for_each = var.api_secret_names
  name     = each.value
}

data "aws_secretsmanager_secret" "secondary" {
  provider = aws.secondary
  for_each = var.api_secret_names
  name     = each.value
}

# ── Networking ───────────────────────────────────────────────────────────────

module "network_primary" {
  source    = "../../modules/network"
  providers = { aws = aws.primary }

  name       = local.name_primary
  cidr_block = var.primary_cidr
}

module "network_secondary" {
  source    = "../../modules/network"
  providers = { aws = aws.secondary }

  name       = local.name_secondary
  cidr_block = var.secondary_cidr
}

# ── Object storage with cross-region replication ─────────────────────────────

module "storage_secondary" {
  source    = "../../modules/storage"
  providers = { aws = aws.secondary }

  bucket_name = "${local.name_secondary}-data-${data.aws_caller_identity.current.account_id}"
  kms_key_arn = aws_kms_replica_key.secondary.arn
}

module "storage_primary" {
  source    = "../../modules/storage"
  providers = { aws = aws.primary }

  bucket_name                         = "${local.name_primary}-data-${data.aws_caller_identity.current.account_id}"
  kms_key_arn                         = aws_kms_key.primary.arn
  replication_destination_bucket_arn  = module.storage_secondary.bucket_arn
  replication_destination_kms_key_arn = aws_kms_replica_key.secondary.arn
}

# ── Compute ──────────────────────────────────────────────────────────────────

module "compute_primary" {
  source    = "../../modules/compute"
  providers = { aws = aws.primary }

  name               = local.name_primary
  vpc_id             = module.network_primary.vpc_id
  vpc_cidr_block     = module.network_primary.vpc_cidr_block
  public_subnet_ids  = module.network_primary.public_subnet_ids
  private_subnet_ids = module.network_primary.private_subnet_ids
  image              = var.api_image
  certificate_arn    = var.primary_certificate_arn
  region_role        = "primary"
  desired_count      = 3
  log_retention_days = var.log_retention_days

  environment = merge(var.api_environment, {
    PEER_REGION_HEALTH_URL = "https://api-${var.secondary_region}.${var.api_domain}/health/ready"
    BACKUP_BUCKET          = module.storage_primary.bucket_id
  })
  secret_arns = { for k, s in data.aws_secretsmanager_secret.primary : k => s.arn }
}

module "compute_secondary" {
  source    = "../../modules/compute"
  providers = { aws = aws.secondary }

  name               = local.name_secondary
  vpc_id             = module.network_secondary.vpc_id
  vpc_cidr_block     = module.network_secondary.vpc_cidr_block
  public_subnet_ids  = module.network_secondary.public_subnet_ids
  private_subnet_ids = module.network_secondary.private_subnet_ids
  image              = var.api_image
  certificate_arn    = var.secondary_certificate_arn
  region_role        = "secondary"
  # Warm standby: enough capacity to pass health checks and absorb the first
  # wave of failed-over traffic while autoscaling catches up.
  desired_count      = 2
  log_retention_days = var.log_retention_days

  environment = merge(var.api_environment, {
    PEER_REGION_HEALTH_URL = "https://api-${var.primary_region}.${var.api_domain}/health/ready"
    BACKUP_BUCKET          = module.storage_secondary.bucket_id
  })
  secret_arns = { for k, s in data.aws_secretsmanager_secret.secondary : k => s.arn }
}

# ── Database (Aurora Global Database) ────────────────────────────────────────

module "database_primary" {
  source    = "../../modules/database"
  providers = { aws = aws.primary }

  name                       = local.name_primary
  vpc_id                     = module.network_primary.vpc_id
  private_subnet_ids         = module.network_primary.private_subnet_ids
  allowed_security_group_ids = [module.compute_primary.task_security_group_id]
  global_cluster_identifier  = local.global_db_id
  kms_key_arn                = aws_kms_key.primary.arn
}

module "database_secondary" {
  source    = "../../modules/database"
  providers = { aws = aws.secondary }

  name                       = local.name_secondary
  vpc_id                     = module.network_secondary.vpc_id
  private_subnet_ids         = module.network_secondary.private_subnet_ids
  allowed_security_group_ids = [module.compute_secondary.task_security_group_id]
  global_cluster_identifier  = local.global_db_id
  is_secondary               = true
  kms_key_arn                = aws_kms_replica_key.secondary.arn
  instance_count             = 1
  alarm_sns_topic_arns       = [aws_sns_topic.secondary_alarms.arn]

  depends_on = [module.database_primary]
}

resource "aws_sns_topic" "secondary_alarms" {
  provider = aws.secondary

  name              = "${local.name_secondary}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "secondary_alarms_email" {
  provider = aws.secondary
  for_each = toset(var.alert_emails)

  topic_arn = aws_sns_topic.secondary_alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

# ── DNS failover ─────────────────────────────────────────────────────────────

module "failover" {
  source    = "../../modules/failover"
  providers = { aws = aws.primary }

  name           = "quorumproof-prod"
  hosted_zone_id = var.hosted_zone_id
  record_name    = var.api_domain
  alert_emails   = var.alert_emails

  regions = {
    (var.primary_region) = {
      role              = "primary"
      alb_dns_name      = module.compute_primary.alb_dns_name
      alb_zone_id       = module.compute_primary.alb_zone_id
      health_check_fqdn = "api-${var.primary_region}.${var.api_domain}"
    }
    (var.secondary_region) = {
      role              = "secondary"
      alb_dns_name      = module.compute_secondary.alb_dns_name
      alb_zone_id       = module.compute_secondary.alb_zone_id
      health_check_fqdn = "api-${var.secondary_region}.${var.api_domain}"
    }
  }
}

# ── Log retention & archival (one archive per region; #1653) ─────────────────

module "log_archive_primary" {
  source    = "../../modules/log-archive"
  providers = { aws = aws.primary }

  name                   = local.name_primary
  bucket_name            = "${local.name_primary}-logs-${data.aws_caller_identity.current.account_id}"
  kms_key_arn            = aws_kms_key.primary.arn
  source_log_group_names = [module.compute_primary.log_group_name]
  object_lock_mode       = "COMPLIANCE"
}

module "log_archive_secondary" {
  source    = "../../modules/log-archive"
  providers = { aws = aws.secondary }

  name                   = local.name_secondary
  bucket_name            = "${local.name_secondary}-logs-${data.aws_caller_identity.current.account_id}"
  kms_key_arn            = aws_kms_replica_key.secondary.arn
  source_log_group_names = [module.compute_secondary.log_group_name]
  object_lock_mode       = "COMPLIANCE"
}
