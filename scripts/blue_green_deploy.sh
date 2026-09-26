#!/usr/bin/env bash
# scripts/blue_green_deploy.sh — Issue #1648: zero-downtime blue-green deploys
# of the api-server on Kubernetes.
#
# Two identical Deployments (quorumproof-api-server-blue / -green, see
# k8s/blue-green/) run side by side. The live Service selects exactly one slot.
# A release goes to the idle slot, is health-validated through the preview
# Service, and only then does traffic switch — atomically, by patching the live
# Service selector. The previous slot is kept warm for instant rollback.
#
# Usage:
#   ./scripts/blue_green_deploy.sh deploy <image>     # full release to idle slot + switch
#   ./scripts/blue_green_deploy.sh switch             # switch traffic to idle slot only
#   ./scripts/blue_green_deploy.sh rollback           # point traffic back at previous slot
#   ./scripts/blue_green_deploy.sh status             # show active/idle slots and images
#   ./scripts/blue_green_deploy.sh scale-down-idle    # release idle slot resources
#
# Environment:
#   BG_NAMESPACE            — namespace (default: quorumproof)
#   BG_APP                  — base name (default: quorumproof-api-server)
#   BG_REPLICAS             — replicas for the new slot (default: current active count, min 2)
#   BG_ROLLOUT_TIMEOUT      — kubectl rollout timeout (default: 300s)
#   BG_HEALTH_RETRIES       — health-check attempts before giving up (default: 10)
#   BG_HEALTH_INTERVAL      — seconds between attempts (default: 6)
#   BG_POST_SWITCH_SOAK     — seconds to watch the new live slot after switching (default: 60)
#   BG_ERROR_THRESHOLD      — max 5xx ratio during soak before auto-rollback (default: 0.05)
#   BG_KEEP_PREVIOUS        — keep previous slot running after success (default: true)
#   PROMETHEUS_URL          — optional; enables error-rate gate during soak
#   NOTIFY_WEBHOOK          — optional Slack/Teams webhook

set -euo pipefail

NS="${BG_NAMESPACE:-quorumproof}"
APP="${BG_APP:-quorumproof-api-server}"
LIVE_SVC="$APP"
PREVIEW_SVC="$APP-preview"
ROLLOUT_TIMEOUT="${BG_ROLLOUT_TIMEOUT:-300s}"
HEALTH_RETRIES="${BG_HEALTH_RETRIES:-10}"
HEALTH_INTERVAL="${BG_HEALTH_INTERVAL:-6}"
POST_SWITCH_SOAK="${BG_POST_SWITCH_SOAK:-60}"
ERROR_THRESHOLD="${BG_ERROR_THRESHOLD:-0.05}"
KEEP_PREVIOUS="${BG_KEEP_PREVIOUS:-true}"
PROMETHEUS_URL="${PROMETHEUS_URL:-}"
NOTIFY_WEBHOOK="${NOTIFY_WEBHOOK:-}"

log()    { echo "[$(date -u +%H:%M:%SZ)] $*"; }
notify() {
  log "NOTIFY: $1"
  [[ -z "$NOTIFY_WEBHOOK" ]] && return 0
  curl -sf -X POST -H 'Content-Type: application/json' \
    -d "$(jq -n --arg t "$1" '{text: $t}')" "$NOTIFY_WEBHOOK" >/dev/null || true
}
die() { log "ERROR: $*"; notify "Blue-green deploy FAILED: $*"; exit 1; }

k() { kubectl -n "$NS" "$@"; }

active_slot() { k get svc "$LIVE_SVC" -o jsonpath='{.spec.selector.slot}'; }
other_slot()  { [[ "$1" == "blue" ]] && echo green || echo blue; }
slot_image()  { k get deploy "$APP-$1" -o jsonpath='{.spec.template.spec.containers[0].image}'; }
slot_ready()  { k get deploy "$APP-$1" -o jsonpath='{.status.readyReplicas}'; }

# Point the live Service at $1 and the preview Service at the other slot.
# A selector patch is a single API write, so kube-proxy moves every new
# connection at once — there is no window with zero endpoints as long as the
# target slot is Ready (checked before calling this).
point_traffic() {
  local to="$1" from="$2"
  k patch svc "$LIVE_SVC" --type merge -p "$(jq -nc --arg to "$to" --arg from "$from" '{
    metadata: {annotations: {"quorumproof.io/active-slot": $to, "quorumproof.io/previous-slot": $from,
                             "quorumproof.io/switched-at": (now | todate)}},
    spec: {selector: {slot: $to}}
  }')" >/dev/null
  k patch svc "$PREVIEW_SVC" --type merge -p "{\"spec\":{\"selector\":{\"slot\":\"$from\"}}}" >/dev/null
  log "Traffic now on '$to' (preview -> '$from')"
}

# ── Health validation ────────────────────────────────────────────────────────
# Runs an ephemeral curl pod inside the cluster against a Service, so the
# check exercises the same network path production traffic will take.
http_check() {
  local svc="$1" path="$2"
  k run "bg-check-$RANDOM" --rm -i --restart=Never --quiet \
    --image=curlimages/curl:8.10.1 -- \
    curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "http://$svc.$NS.svc$path" 2>/dev/null
}

validate_slot() {
  local slot="$1" svc="$2"
  log "Validating slot '$slot' via service '$svc'"

  local ready desired
  ready="$(slot_ready "$slot")"; ready="${ready:-0}"
  desired="$(k get deploy "$APP-$slot" -o jsonpath='{.spec.replicas}')"
  [[ "$ready" -ge 1 && "$ready" -eq "$desired" ]] \
    || { log "  [FAIL] $ready/$desired replicas Ready"; return 1; }
  log "  [PASS] $ready/$desired replicas Ready"

  local path code attempt
  for path in /health/live /health/ready /health; do
    for attempt in $(seq 1 "$HEALTH_RETRIES"); do
      code="$(http_check "$svc" "$path" || true)"
      [[ "$code" == "200" ]] && break
      sleep "$HEALTH_INTERVAL"
    done
    [[ "$code" == "200" ]] || { log "  [FAIL] GET $path -> ${code:-no response}"; return 1; }
    log "  [PASS] GET $path -> 200"
  done

  # No restarts during startup is a cheap signal for crash loops that the
  # probes might not have caught yet.
  local restarts
  restarts="$(k get pods -l "app=$APP,slot=$slot" \
    -o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{"\n"}{end}' \
    | awk '{s+=$1} END {print s+0}')"
  [[ "$restarts" -eq 0 ]] || { log "  [FAIL] $restarts container restart(s)"; return 1; }
  log "  [PASS] no container restarts"
}

error_rate() {
  local slot="$1"
  [[ -z "$PROMETHEUS_URL" ]] && { echo 0; return; }
  local q="sum(rate(http_requests_total{slot=\"$slot\",status=~\"5..\"}[1m])) / clamp_min(sum(rate(http_requests_total{slot=\"$slot\"}[1m])), 1)"
  curl -sf --get "$PROMETHEUS_URL/api/v1/query" --data-urlencode "query=$q" \
    | jq -r '.data.result[0].value[1] // "0"' 2>/dev/null || echo 0
}

soak() {
  local slot="$1" deadline=$(( $(date +%s) + POST_SWITCH_SOAK ))
  log "Soaking '$slot' for ${POST_SWITCH_SOAK}s"
  while [[ $(date +%s) -lt $deadline ]]; do
    local rate
    rate="$(error_rate "$slot")"
    if awk -v r="$rate" -v t="$ERROR_THRESHOLD" 'BEGIN { exit !(r > t) }'; then
      log "  error rate $rate > $ERROR_THRESHOLD"
      return 1
    fi
    local code
    code="$(http_check "$LIVE_SVC" /health/ready || true)"
    [[ "$code" == "200" ]] || { log "  live /health/ready -> ${code:-no response}"; return 1; }
    sleep 10
  done
  log "  soak passed"
}

# ── Commands ─────────────────────────────────────────────────────────────────
cmd_status() {
  local active idle
  active="$(active_slot)"; idle="$(other_slot "$active")"
  echo "live service : $LIVE_SVC -> $active"
  echo "previous     : $(k get svc "$LIVE_SVC" -o jsonpath='{.metadata.annotations.quorumproof\.io/previous-slot}')"
  echo "switched at  : $(k get svc "$LIVE_SVC" -o jsonpath='{.metadata.annotations.quorumproof\.io/switched-at}')"
  for s in "$active" "$idle"; do
    printf '%-6s image=%s ready=%s/%s\n' "$s" "$(slot_image "$s")" \
      "$(slot_ready "$s")" "$(k get deploy "$APP-$s" -o jsonpath='{.spec.replicas}')"
  done
}

cmd_switch() {
  local active idle
  active="$(active_slot)"; idle="$(other_slot "$active")"
  validate_slot "$idle" "$PREVIEW_SVC" || die "idle slot '$idle' failed validation; traffic unchanged on '$active'"
  point_traffic "$idle" "$active"
  if ! soak "$idle"; then
    log "Post-switch soak failed — rolling back automatically"
    point_traffic "$active" "$idle"
    die "'$idle' unhealthy after switch; rolled back to '$active'"
  fi
  notify "Blue-green: traffic switched $active -> $idle ($(slot_image "$idle"))"
  if [[ "$KEEP_PREVIOUS" != "true" ]]; then
    k scale deploy "$APP-$active" --replicas=0 >/dev/null
    log "Scaled previous slot '$active' to 0"
  else
    log "Previous slot '$active' kept warm for instant rollback"
  fi
}

cmd_deploy() {
  local image="${1:?Usage: $0 deploy <image>}"
  local active idle replicas
  active="$(active_slot)"; idle="$(other_slot "$active")"
  replicas="${BG_REPLICAS:-$(k get deploy "$APP-$active" -o jsonpath='{.spec.replicas}')}"
  [[ "${replicas:-0}" -lt 2 ]] && replicas=2

  log "Active: $active ($(slot_image "$active")); deploying $image to idle slot '$idle' x$replicas"

  k set image "deploy/$APP-$idle" "api-server=$image" >/dev/null
  k annotate "deploy/$APP-$idle" kubernetes.io/change-cause="blue-green deploy $image" --overwrite >/dev/null
  k scale "deploy/$APP-$idle" --replicas="$replicas" >/dev/null
  k rollout status "deploy/$APP-$idle" --timeout="$ROLLOUT_TIMEOUT" \
    || die "rollout of '$idle' did not complete within $ROLLOUT_TIMEOUT; traffic unchanged on '$active'"

  # Make sure the preview Service is pointed at the slot we just deployed.
  k patch svc "$PREVIEW_SVC" --type merge -p "{\"spec\":{\"selector\":{\"slot\":\"$idle\"}}}" >/dev/null

  cmd_switch
  log "Deploy complete: $image live on '$idle'"
}

cmd_rollback() {
  local active previous
  active="$(active_slot)"
  previous="$(k get svc "$LIVE_SVC" -o jsonpath='{.metadata.annotations.quorumproof\.io/previous-slot}')"
  previous="${previous:-$(other_slot "$active")}"

  local ready
  ready="$(slot_ready "$previous")"
  if [[ "${ready:-0}" -lt 1 ]]; then
    log "Previous slot '$previous' has no Ready replicas — scaling up first"
    k scale "deploy/$APP-$previous" --replicas="$(k get deploy "$APP-$active" -o jsonpath='{.spec.replicas}')" >/dev/null
    k rollout status "deploy/$APP-$previous" --timeout="$ROLLOUT_TIMEOUT" \
      || die "previous slot '$previous' could not be brought up; traffic unchanged on '$active'"
  fi

  point_traffic "$previous" "$active"
  notify "Blue-green: ROLLED BACK $active -> $previous ($(slot_image "$previous"))"
}

cmd_scale_down_idle() {
  local idle
  idle="$(other_slot "$(active_slot)")"
  k scale "deploy/$APP-$idle" --replicas=0 >/dev/null
  log "Scaled idle slot '$idle' to 0 (rollback will now require a scale-up)"
}

case "${1:-}" in
  deploy)          shift; cmd_deploy "$@" ;;
  switch)          cmd_switch ;;
  rollback)        cmd_rollback ;;
  status)          cmd_status ;;
  scale-down-idle) cmd_scale_down_idle ;;
  *) sed -n '2,30p' "$0"; exit 1 ;;
esac
