# Staging — single region, cost-reduced mirror of production (#1652).

locals {
  name = "quorumproof-staging"
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "quorumproof"
      Environment = "staging"
      ManagedBy   = "terraform"
      Repository  = "QuorumProof/QuorumProof"
      Region      = var.region
    }
  }
}

data "aws_caller_identity" "current" {}

module "network" {
  source = "../../modules/network"

  name               = local.name
  cidr_block         = "10.30.0.0/16"
  az_count           = 2
  single_nat_gateway = true
}

module "storage" {
  source = "../../modules/storage"

  bucket_name = "${local.name}-data-${data.aws_caller_identity.current.account_id}"
}

module "compute" {
  source = "../../modules/compute"

  name                = local.name
  vpc_id              = module.network.vpc_id
  vpc_cidr_block      = module.network.vpc_cidr_block
  public_subnet_ids   = module.network.public_subnet_ids
  private_subnet_ids  = module.network.private_subnet_ids
  image               = var.api_image
  certificate_arn     = var.certificate_arn
  desired_count       = 1
  max_count           = 3
  deletion_protection = false
  log_retention_days  = 14
  environment         = merge(var.api_environment, { BACKUP_BUCKET = module.storage.bucket_id })
}

module "database" {
  source = "../../modules/database"

  name                       = local.name
  vpc_id                     = module.network.vpc_id
  private_subnet_ids         = module.network.private_subnet_ids
  allowed_security_group_ids = [module.compute.task_security_group_id]
  instance_class             = "db.t4g.medium"
  instance_count             = 1
  deletion_protection        = false
  backup_retention_days      = 3
}

module "log_archive" {
  source = "../../modules/log-archive"

  name                   = local.name
  bucket_name            = "${local.name}-logs-${data.aws_caller_identity.current.account_id}"
  source_log_group_names = [module.compute.log_group_name]
  expire_after_days      = 365
  object_lock_mode       = null
}
