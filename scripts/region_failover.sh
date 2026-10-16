#!/usr/bin/env bash
# scripts/region_failover.sh — #1650 Multi-region (infrastructure) failover.
#
# Operates on the production stack in infra/terraform/environments/production.
# Region metadata is read from `terraform output -json regions`, or from
# REGIONS_JSON (a file path) when Terraform state is unavailable.
#
# Not to be confused with scripts/failover.sh, which switches Soroban RPC
# endpoints; this script moves the whole api-server + database between AWS
# regions.
#
# Usage:
#   scripts/region_failover.sh status
#       Show Route 53 health, api-server /health/region, Aurora global
#       cluster membership and replication lag for both regions.
#
#   scripts/region_failover.sh planned [--yes] [--dry-run]
#       Planned switchover (maintenance / DR drill). Scales up the secondary,
#       runs an Aurora managed switchover (no data loss — waits for the
#       secondary to fully catch up) and flips which region is primary.
#
#   scripts/region_failover.sh unplanned [--yes] [--dry-run]
#       Primary region is down. Scales up the secondary, detaches the
#       secondary Aurora cluster from the global cluster so it becomes a
#       standalone writer (RPO = replication lag at time of failure), and
#       verifies the secondary is serving. DNS moves automatically via the
#       Route 53 failover records.
#
#   scripts/region_failover.sh drill <scenario> [--dry-run]
#       Run a failover test scenario (see docs/multi-region-failover.md
#       § "Failover test scenarios"):
#         primary-api-down   scale primary ECS service to 0, observe DNS failover, restore
#         health-check-flap  toggle primary health check inversion to verify hysteresis
#         db-switchover      planned Aurora switchover and back
#
# Requires: aws (v2), jq, curl; terraform when REGIONS_JSON is not set.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform/environments/production"
GLOBAL_CLUSTER="${GLOBAL_CLUSTER:-quorumproof-prod-global}"
SECONDARY_SCALE_TO="${SECONDARY_SCALE_TO:-3}"

CMD="${1:-}"; shift || true
ASSUME_YES=0
DRY_RUN=0
SCENARIO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) if [[ "$CMD" == "drill" && -z "$SCENARIO" ]]; then SCENARIO="$1"; else echo "unknown argument: $1" >&2; exit 2; fi ;;
  esac
  shift
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

confirm() {
  [[ $ASSUME_YES -eq 1 || $DRY_RUN -eq 1 ]] && return 0
  read -r -p "$1 Type 'failover' to continue: " answer
  [[ "$answer" == "failover" ]] || die "aborted"
}

for bin in aws jq curl; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' is required"
done

load_regions() {
  if [[ -n "${REGIONS_JSON:-}" ]]; then
    REGIONS="$(cat "$REGIONS_JSON")"
  else
    command -v terraform >/dev/null 2>&1 || die "terraform is required (or set REGIONS_JSON)"
    REGIONS="$(terraform -chdir="$TF_DIR" output -json regions)"
  fi
  r() { jq -r ".$1.$2" <<<"$REGIONS"; }
  P_REGION=$(r primary region);   S_REGION=$(r secondary region)
  P_CLUSTER=$(r primary ecs_cluster); S_CLUSTER=$(r secondary ecs_cluster)
  P_SERVICE=$(r primary ecs_service); S_SERVICE=$(r secondary ecs_service)
  P_DB=$(r primary db_cluster);   S_DB=$(r secondary db_cluster)
  P_HOST=$(r primary health_check_fqdn); S_HOST=$(r secondary health_check_fqdn)
}

db_arn() { aws rds describe-db-clusters --region "$1" --db-cluster-identifier "$2" --query 'DBClusters[0].DBClusterArn' --output text; }

region_status() {
  local label="$1" region="$2" host="$3" cluster="$4" service="$5" db="$6"
  echo "── $label ($region) ─────────────────────────────────"
  local ready
  ready=$(curl -fsS -m 5 -o /dev/null -w '%{http_code}' "https://$host/health/ready" 2>/dev/null || echo "unreachable")
  echo "  /health/ready        : $ready"
  curl -fsS -m 5 "https://$host/health/region" 2>/dev/null \
    | jq -r '"  peer state           : \(.peer.state)\n  failoverActive       : \(.failoverActive)"' \
    || echo "  /health/region       : unreachable"
  aws ecs describe-services --region "$region" --cluster "$cluster" --services "$service" \
    --query 'services[0].[desiredCount,runningCount]' --output text 2>/dev/null \
    | awk '{print "  ECS desired/running  : " $1 "/" $2}' || echo "  ECS                  : unavailable"
  aws rds describe-db-clusters --region "$region" --db-cluster-identifier "$db" \
    --query 'DBClusters[0].[Status,GlobalWriteForwardingStatus]' --output text 2>/dev/null \
    | awk '{print "  Aurora status        : " $1}' || echo "  Aurora               : unavailable"
}

cmd_status() {
  load_regions
  region_status primary "$P_REGION" "$P_HOST" "$P_CLUSTER" "$P_SERVICE" "$P_DB"
  region_status secondary "$S_REGION" "$S_HOST" "$S_CLUSTER" "$S_SERVICE" "$S_DB"
  echo "── Aurora global cluster ($GLOBAL_CLUSTER) ─────────"
  aws rds describe-global-clusters --region "$P_REGION" --global-cluster-identifier "$GLOBAL_CLUSTER" \
    --query 'GlobalClusters[0].GlobalClusterMembers[].[DBClusterArn,IsWriter]' --output text 2>/dev/null \
    | awk '{printf "  %-90s writer=%s\n", $1, $2}' || echo "  unavailable (primary region API unreachable?)"
  local lag
  lag=$(aws cloudwatch get-metric-statistics --region "$S_REGION" --namespace AWS/RDS \
    --metric-name AuroraGlobalDBReplicationLag --dimensions "Name=DBClusterIdentifier,Value=$S_DB" \
    --start-time "$(date -u -d '-5 min' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
    --period 60 --statistics Maximum --query 'max(Datapoints[].Maximum)' --output text 2>/dev/null || echo "n/a")
  echo "  replication lag (5m max, ms): $lag"
}

scale_secondary() {
  log "Scaling secondary api-server ($S_REGION) to $SECONDARY_SCALE_TO tasks"
  run aws ecs update-service --region "$S_REGION" --cluster "$S_CLUSTER" --service "$S_SERVICE" \
    --desired-count "$SECONDARY_SCALE_TO" >/dev/null
  run aws ecs wait services-stable --region "$S_REGION" --cluster "$S_CLUSTER" --services "$S_SERVICE"
}

wait_ready() {
  local host="$1" tries=30
  log "Waiting for https://$host/health/ready"
  [[ $DRY_RUN -eq 1 ]] && { echo "  [dry-run] skip"; return 0; }
  until curl -fsS -m 5 -o /dev/null "https://$host/health/ready"; do
    tries=$((tries - 1))
    [[ $tries -le 0 ]] && die "$host did not become ready"
    sleep 10
  done
  log "$host is ready"
}

cmd_planned() {
  load_regions
  confirm "Planned switchover: $P_REGION → $S_REGION (no data loss)."
  scale_secondary
  local target
  target=$(db_arn "$S_REGION" "$S_DB")
  log "Aurora managed switchover of $GLOBAL_CLUSTER to $target"
  run aws rds switchover-global-cluster --region "$S_REGION" \
    --global-cluster-identifier "$GLOBAL_CLUSTER" --target-db-cluster-identifier "$target"
  log "Waiting for global cluster to become available"
  if [[ $DRY_RUN -eq 0 ]]; then
    until [[ "$(aws rds describe-global-clusters --region "$S_REGION" --global-cluster-identifier "$GLOBAL_CLUSTER" --query 'GlobalClusters[0].Status' --output text)" == "available" ]]; do
      sleep 15
    done
  fi
  wait_ready "$S_HOST"
  cat <<MSG

Switchover complete. $S_REGION now hosts the Aurora writer.
Next steps (see docs/multi-region-failover.md § "After a failover"):
  1. Swap primary_region/secondary_region in the production tfvars and open a PR
     so Terraform, Route 53 PRIMARY/SECONDARY records and REGION_ROLE match reality.
  2. Update the status page and close the incident / drill ticket.
MSG
}

cmd_unplanned() {
  load_regions
  warn "Unplanned failover detaches $S_DB from $GLOBAL_CLUSTER. Writes not yet replicated from $P_REGION are lost (RPO = replication lag)."
  confirm "Unplanned failover: promote $S_REGION to standalone writer."
  scale_secondary
  local target
  target=$(db_arn "$S_REGION" "$S_DB")
  log "Detaching $target from $GLOBAL_CLUSTER (promotes it to a writer)"
  run aws rds remove-from-global-cluster --region "$S_REGION" \
    --global-cluster-identifier "$GLOBAL_CLUSTER" --db-cluster-identifier "$target"
  if [[ $DRY_RUN -eq 0 ]]; then
    aws rds wait db-cluster-available --region "$S_REGION" --db-cluster-identifier "$S_DB"
  fi
  log "Restarting secondary api-server tasks so they reconnect to the new writer"
  run aws ecs update-service --region "$S_REGION" --cluster "$S_CLUSTER" --service "$S_SERVICE" --force-new-deployment >/dev/null
  run aws ecs wait services-stable --region "$S_REGION" --cluster "$S_CLUSTER" --services "$S_SERVICE"
  wait_ready "$S_HOST"
  cat <<MSG

Unplanned failover complete. $S_REGION is serving with a standalone Aurora writer.
When $P_REGION recovers:
  1. Do NOT start the old primary's api-server against its old database (split brain).
  2. Rebuild a global cluster from $S_DB and re-add $P_REGION as secondary
     (docs/multi-region-failover.md § "Failback").
MSG
}

cmd_drill() {
  load_regions
  case "$SCENARIO" in
    primary-api-down)
      confirm "Drill: scale $P_REGION api-server to 0 and observe DNS failover."
      local original
      original=$(aws ecs describe-services --region "$P_REGION" --cluster "$P_CLUSTER" --services "$P_SERVICE" --query 'services[0].desiredCount' --output text)
      scale_secondary
      log "Stopping primary api-server"
      run aws ecs update-service --region "$P_REGION" --cluster "$P_CLUSTER" --service "$P_SERVICE" --desired-count 0 >/dev/null
      log "Expect Route 53 to fail over within ~$((10 * 3 + 60))s; watch: dig +short \$API_DOMAIN and /health/region on $S_HOST"
      [[ $DRY_RUN -eq 0 ]] && sleep 120
      cmd_status
      log "Restoring primary api-server to $original tasks"
      run aws ecs update-service --region "$P_REGION" --cluster "$P_CLUSTER" --service "$P_SERVICE" --desired-count "$original" >/dev/null
      run aws ecs wait services-stable --region "$P_REGION" --cluster "$P_CLUSTER" --services "$P_SERVICE"
      wait_ready "$P_HOST"
      ;;
    health-check-flap)
      local hc
      hc=$(terraform -chdir="$TF_DIR" output -json health_check_ids | jq -r --arg r "$P_REGION" '.[$r]')
      confirm "Drill: invert Route 53 health check $hc for 60s."
      run aws route53 update-health-check --health-check-id "$hc" --inverted
      [[ $DRY_RUN -eq 0 ]] && sleep 60
      run aws route53 update-health-check --health-check-id "$hc" --no-inverted
      log "Verify: failover alarm fired and cleared; secondary /health/region showed failoverActive then recovered."
      ;;
    db-switchover)
      cmd_planned
      log "Reverse switchover back to $P_REGION"
      local back
      back=$(db_arn "$P_REGION" "$P_DB")
      run aws rds switchover-global-cluster --region "$P_REGION" \
        --global-cluster-identifier "$GLOBAL_CLUSTER" --target-db-cluster-identifier "$back"
      ;;
    *) die "unknown drill scenario '$SCENARIO' (primary-api-down | health-check-flap | db-switchover)" ;;
  esac
}

case "$CMD" in
  status) cmd_status ;;
  planned) cmd_planned ;;
  unplanned) cmd_unplanned ;;
  drill) cmd_drill ;;
  *) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
