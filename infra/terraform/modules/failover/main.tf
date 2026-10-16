# Failover module — DNS-level active/passive failover between two regions
# (#1650).
#
# Route 53 health checkers in several AWS locations probe each region's
# `/health/ready` endpoint over HTTPS. While the primary is healthy, the
# PRIMARY failover record answers; once `failure_threshold` consecutive
# checks fail from a majority of checkers, Route 53 starts answering with the
# SECONDARY record. Recovery is automatic in the opposite direction.
#
# NOTE: Route 53 health-check metrics are only published in us-east-1, so
# this module must be instantiated with a us-east-1 AWS provider.

resource "aws_route53_health_check" "region" {
  for_each = var.regions

  fqdn              = each.value.health_check_fqdn
  port              = 443
  type              = "HTTPS"
  resource_path     = var.health_check_path
  request_interval  = var.request_interval
  failure_threshold = var.failure_threshold
  measure_latency   = true
  enable_sni        = true
  regions           = var.checker_regions

  tags = {
    Name       = "${var.name}-${each.key}"
    RegionRole = each.value.role
  }
}

resource "aws_route53_record" "failover" {
  for_each = var.regions

  zone_id        = var.hosted_zone_id
  name           = var.record_name
  type           = "A"
  set_identifier = "${var.name}-${each.key}"

  failover_routing_policy {
    type = upper(each.value.role)
  }

  health_check_id = aws_route53_health_check.region[each.key].id

  alias {
    name                   = each.value.alb_dns_name
    zone_id                = each.value.alb_zone_id
    evaluate_target_health = true
  }
}

# Per-region records (api-use1.example.com, …) so operators and the
# failover detector can always reach a specific region directly.
resource "aws_route53_record" "regional" {
  for_each = var.regions

  zone_id = var.hosted_zone_id
  name    = each.value.health_check_fqdn
  type    = "A"

  alias {
    name                   = each.value.alb_dns_name
    zone_id                = each.value.alb_zone_id
    evaluate_target_health = true
  }
}

# ── Failover detection alerting ──────────────────────────────────────────────

resource "aws_sns_topic" "failover" {
  name              = "${var.name}-region-failover"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alert_emails)

  topic_arn = aws_sns_topic.failover.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_cloudwatch_metric_alarm" "region_unhealthy" {
  for_each = var.regions

  alarm_name          = "${var.name}-${each.key}-unhealthy"
  alarm_description   = "Route 53 health check for ${each.key} (${each.value.role}) is failing — DNS failover ${each.value.role == "primary" ? "to the secondary region is in effect" : "target is unavailable"} (#1650)."
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.failover.arn]
  ok_actions          = [aws_sns_topic.failover.arn]

  dimensions = {
    HealthCheckId = aws_route53_health_check.region[each.key].id
  }
}
