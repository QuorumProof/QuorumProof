# Database module — Aurora PostgreSQL, optionally as a member of an Aurora
# Global Database (#1650).
#
#   * Primary region: set `global_cluster_identifier` to create the global
#     cluster and a writer cluster attached to it.
#   * Secondary region: set `global_cluster_identifier` to the SAME id and
#     `is_secondary = true`; the cluster joins as a read-only replica fed by
#     Aurora storage-level replication (typical lag < 1s).
#
# Promotion of the secondary during a regional failover is done by
# scripts/region_failover.sh (managed `failover-global-cluster`, or
# `remove-from-global-cluster` for an unplanned outage) — not by Terraform,
# so that an apply during an incident can never fight the failover.

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db"
  subnet_ids = var.private_subnet_ids
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Aurora PostgreSQL; ingress from api-server tasks only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL from api-server"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = var.allowed_security_group_ids
  }
}

resource "aws_rds_global_cluster" "this" {
  count = var.global_cluster_identifier != null && !var.is_secondary ? 1 : 0

  global_cluster_identifier = var.global_cluster_identifier
  engine                    = "aurora-postgresql"
  engine_version            = var.engine_version
  database_name             = var.database_name
  storage_encrypted         = true
  deletion_protection       = var.deletion_protection
}

resource "aws_rds_cluster" "this" {
  cluster_identifier        = "${var.name}-aurora"
  engine                    = "aurora-postgresql"
  engine_version            = var.engine_version
  global_cluster_identifier = var.global_cluster_identifier

  # A secondary cluster inherits the database name and credentials from the
  # primary via replication and must not set them.
  database_name               = var.is_secondary ? null : var.database_name
  master_username             = var.is_secondary ? null : var.master_username
  manage_master_user_password = var.is_secondary ? null : true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]

  storage_encrypted = true
  kms_key_id        = var.kms_key_arn

  backup_retention_period         = var.backup_retention_days
  preferred_backup_window         = "03:00-04:00"
  copy_tags_to_snapshot           = true
  deletion_protection             = var.deletion_protection
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.name}-aurora-final"
  enabled_cloudwatch_logs_exports = ["postgresql"]

  depends_on = [aws_rds_global_cluster.this]

  lifecycle {
    # After a failover the global cluster membership / replication source
    # changes out-of-band; do not let Terraform revert it.
    ignore_changes = [global_cluster_identifier, replication_source_identifier]
  }
}

resource "aws_rds_cluster_instance" "this" {
  count = var.instance_count

  identifier                   = "${var.name}-aurora-${count.index}"
  cluster_identifier           = aws_rds_cluster.this.id
  engine                       = aws_rds_cluster.this.engine
  engine_version               = aws_rds_cluster.this.engine_version
  instance_class               = var.instance_class
  db_subnet_group_name         = aws_db_subnet_group.this.name
  performance_insights_enabled = true
  auto_minor_version_upgrade   = true
}

# Replication lag alarm — fires into the same SNS topic as the failover
# health checks so on-call sees data-replication problems before a failover
# would lose data.
resource "aws_cloudwatch_metric_alarm" "replication_lag" {
  count = var.is_secondary ? 1 : 0

  alarm_name          = "${var.name}-aurora-global-replication-lag"
  alarm_description   = "Aurora global database replication lag above ${var.replication_lag_alarm_ms}ms (#1650)"
  namespace           = "AWS/RDS"
  metric_name         = "AuroraGlobalDBReplicationLag"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.replication_lag_alarm_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns

  dimensions = {
    DBClusterIdentifier = aws_rds_cluster.this.cluster_identifier
  }
}
