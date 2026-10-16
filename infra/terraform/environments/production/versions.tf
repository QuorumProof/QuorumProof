terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }

  # Partial configuration — supply the rest with
  #   terraform init -backend-config=backend.hcl
  # (see backend.hcl.example).
  backend "s3" {
    key     = "production/terraform.tfstate"
    encrypt = true
  }
}
