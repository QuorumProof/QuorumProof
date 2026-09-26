output "cluster_identifier" {
  description = "Regional Aurora cluster identifier."
  value       = aws_rds_cluster.this.cluster_identifier
}

output "cluster_arn" {
  description = "Regional Aurora cluster ARN."
  value       = aws_rds_cluster.this.arn
}

output "writer_endpoint" {
  description = "Cluster (writer) endpoint. On a secondary this becomes writable only after promotion."
  value       = aws_rds_cluster.this.endpoint
}

output "reader_endpoint" {
  description = "Reader endpoint."
  value       = aws_rds_cluster.this.reader_endpoint
}

output "master_user_secret_arn" {
  description = "Secrets Manager ARN holding the master credentials (primary only)."
  value       = try(aws_rds_cluster.this.master_user_secret[0].secret_arn, null)
}

output "global_cluster_identifier" {
  description = "Global cluster id, if any."
  value       = var.global_cluster_identifier
}
