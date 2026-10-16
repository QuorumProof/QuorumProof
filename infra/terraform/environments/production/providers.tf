locals {
  common_tags = {
    Project     = "quorumproof"
    Environment = "production"
    ManagedBy   = "terraform"
    Repository  = "QuorumProof/QuorumProof"
  }
}

# Primary region. Also used for global resources (Route 53 health checks and
# their CloudWatch alarms must live in us-east-1).
provider "aws" {
  alias  = "primary"
  region = var.primary_region

  default_tags {
    tags = merge(local.common_tags, { Region = var.primary_region, RegionRole = "primary" })
  }
}

provider "aws" {
  alias  = "secondary"
  region = var.secondary_region

  default_tags {
    tags = merge(local.common_tags, { Region = var.secondary_region, RegionRole = "secondary" })
  }
}
