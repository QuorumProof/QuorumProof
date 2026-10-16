# terraform test — plan-only, no AWS credentials required (#1652).

mock_provider "aws" {
  override_data {
    target = data.aws_availability_zones.available
    values = { names = ["us-east-1a", "us-east-1b", "us-east-1c"] }
  }
}

variables {
  name       = "qp-test"
  cidr_block = "10.10.0.0/16"
}

run "creates_one_subnet_pair_per_az" {
  command = plan

  assert {
    condition     = length(aws_subnet.public) == 3 && length(aws_subnet.private) == 3
    error_message = "expected 3 public and 3 private subnets"
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 3
    error_message = "HA mode must create one NAT gateway per AZ"
  }
}

run "single_nat_gateway" {
  command = plan

  variables {
    az_count           = 2
    single_nat_gateway = true
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 1
    error_message = "single_nat_gateway must create exactly one NAT gateway"
  }
}

run "rejects_invalid_cidr" {
  command = plan

  variables {
    cidr_block = "not-a-cidr"
  }

  expect_failures = [var.cidr_block]
}
