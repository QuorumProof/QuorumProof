mock_provider "aws" {}

variables {
  name           = "qp-test"
  hosted_zone_id = "Z000TEST"
  record_name    = "api.example.com"
  regions = {
    use1 = {
      role              = "primary"
      alb_dns_name      = "primary.elb.amazonaws.com"
      alb_zone_id       = "Z35SXDOTRQ7X7K"
      health_check_fqdn = "api-use1.example.com"
    }
    euw1 = {
      role              = "secondary"
      alb_dns_name      = "secondary.elb.amazonaws.com"
      alb_zone_id       = "Z32O12XQLNTSW2"
      health_check_fqdn = "api-euw1.example.com"
    }
  }
}

run "primary_and_secondary_records" {
  command = plan

  assert {
    condition     = aws_route53_record.failover["use1"].failover_routing_policy[0].type == "PRIMARY"
    error_message = "use1 must be the PRIMARY failover record"
  }

  assert {
    condition     = aws_route53_record.failover["euw1"].failover_routing_policy[0].type == "SECONDARY"
    error_message = "euw1 must be the SECONDARY failover record"
  }

  assert {
    condition     = aws_route53_health_check.region["use1"].resource_path == "/health/ready"
    error_message = "health checks must probe the readiness endpoint"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.region_unhealthy) == 2
    error_message = "one unhealthy-region alarm per region expected"
  }
}

run "rejects_two_primaries" {
  command = plan

  variables {
    regions = {
      a = { role = "primary", alb_dns_name = "a", alb_zone_id = "Z1", health_check_fqdn = "a.example.com" }
      b = { role = "primary", alb_dns_name = "b", alb_zone_id = "Z2", health_check_fqdn = "b.example.com" }
    }
  }

  expect_failures = [var.regions]
}
