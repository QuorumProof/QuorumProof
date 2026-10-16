#!/usr/bin/env bash
# scripts/canary_k8s.sh — Issue #1654: Kubernetes canary deployment management.
#
# Manages the full lifecycle of a Kubernetes-level canary deployment for the
# QuorumProof API server:
#
#   deploy   — Launch canary at a given traffic percentage
#   monitor  — Monitor metrics for the soak period and promote/rollback
#   promote  — Promote canary to stable (scale stable, delete canary)
#   rollback — Immediately delete canary and restore 100% stable traffic
#   status   — Show current canary state
#
# Traffic splitting is weight-by-replica-count via the shared Service:
#   canary_pct ≈ canary_replicas / (stable_replicas + canary_replicas)
#
# Usage:
#   ./scripts/canary_k8s.sh deploy   --image quorumproof/api-server:v1.2.0 [--pct 10]
#   ./scripts/canary_k8s.sh monitor  [--soak 300] [--error-threshold 0.05] [--p95-ms 2000]
#   ./scripts/canary_k8s.sh promote  --image quorumproof/api-server:v1.2.0
#   ./scripts/canary_k8s.sh rollback
#   ./scripts/canary_k8s.sh status
#
# Environment variables:
#   NAMESPACE          — Kubernetes namespace (default: quorumproof)
#   PROMETHEUS_URL     — Prometheus base URL for metric queries
#   NOTIFY_WEBHOOK     — Slack/Teams webhook for failure notifications
#   STABLE_REPLICAS    — Number of stable replicas (default: auto-detected)

set -euo pipefail

NAMESPACE="${NAMESPACE:-quorumproof}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus.monitoring.svc.cluster.local:9090}"
NOTIFY_WEBHOOK="${NOTIFY_WEBHOOK:-}"
KUBECTL="${KUBECTL:-kubectl}"
STABLE_DEPLOYMENT="quorumproof-api-server"
CANARY_DEPLOYMENT="quorumproof-api-server-canary"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()    { echo "[$(date -u +%H:%M:%SZ)] $*"; }
fail()   { log "ERROR: $*"; notify "CANARY FAILED: $*"; exit 1; }
notify() {
  local msg="$1"
  if [[ -n "$NOTIFY_WEBHOOK" ]]; then
    curl -sf -X POST "$NOTIFY_WEBHOOK" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"[QuorumProof K8s Canary] $msg\"}" || true
  fi
}
hr() { printf '%0.s─' {1..70}; echo; }

require_cmd() { command -v "$1" &>/dev/null || fail "Required: $1"; }
require_cmd kubectl
require_cmd jq
require_cmd curl

# ── Helpers ───────────────────────────────────────────────────────────────────
stable_replicas() {
  $KUBECTL get deployment "$STABLE_DEPLOYMENT" \
    -n "$NAMESPACE" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "9"
}

canary_exists() {
  $KUBECTL get deployment "$CANARY_DEPLOYMENT" -n "$NAMESPACE" &>/dev/null
}

pct_to_canary_replicas() {
  local pct="$1"
  local stable
  stable=$(stable_replicas)
  # canary_replicas = round(stable * pct / (100 - pct))
  python3 -c "import math; print(max(1, round($stable * $pct / (100 - $pct))))" 2>/dev/null || echo "1"
}

query_prometheus() {
  local query="$1"
  curl -sf \
    "${PROMETHEUS_URL}/api/v1/query" \
    --data-urlencode "query=${query}" \
    | jq -r '.data.result[0].value[1] // "0"' 2>/dev/null || echo "0"
}

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_deploy() {
  local image=""
  local pct=10

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --image) image="${2:?}"; shift ;;
      --pct)   pct="${2:?}"; shift ;;
      *) fail "deploy: unknown option $1" ;;
    esac
    shift
  done

  [[ -n "$image" ]] || fail "deploy: --image is required"

  if canary_exists; then
    fail "Canary deployment already exists. Run 'rollback' first or 'status' to inspect."
  fi

  CANARY_REPLICAS=$(pct_to_canary_replicas "$pct")
  STABLE=$(stable_replicas)

  log "Deploying canary: image=${image}, pct=${pct}%, canary_replicas=${CANARY_REPLICAS}, stable_replicas=${STABLE}"

  # Apply the canary deployment manifest
  $KUBECTL apply -k "${ROOT_DIR}/k8s/canary/" -n "$NAMESPACE"

  # Set the canary image
  $KUBECTL set image deployment/"$CANARY_DEPLOYMENT" \
    api-server="$image" \
    -n "$NAMESPACE"

  # Scale to the target canary replica count
  $KUBECTL scale deployment/"$CANARY_DEPLOYMENT" \
    --replicas="$CANARY_REPLICAS" \
    -n "$NAMESPACE"

  # Wait for canary pods to be ready
  log "Waiting for canary pods to be ready..."
  $KUBECTL rollout status deployment/"$CANARY_DEPLOYMENT" \
    -n "$NAMESPACE" \
    --timeout=300s \
    || fail "Canary deployment failed to roll out"

  log "Canary deployed. Traffic split: ~${pct}% canary / ~$((100 - pct))% stable"
  notify "Canary deployed: ${image} at ${pct}% traffic in ${NAMESPACE}."
}

cmd_monitor() {
  local soak=300
  local error_threshold="0.05"
  local p95_ms=2000

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --soak)            soak="${2:?}"; shift ;;
      --error-threshold) error_threshold="${2:?}"; shift ;;
      --p95-ms)          p95_ms="${2:?}"; shift ;;
      *) fail "monitor: unknown option $1" ;;
    esac
    shift
  done

  canary_exists || fail "No canary deployment found. Run 'deploy' first."

  CANARY_IMAGE=$($KUBECTL get deployment "$CANARY_DEPLOYMENT" -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null)

  log "Monitoring canary (image=${CANARY_IMAGE}) for ${soak}s soak period..."
  log "Thresholds: error_rate < ${error_threshold}, p95_latency < ${p95_ms}ms"

  CHECK_INTERVAL=15
  ELAPSED=0

  while [[ $ELAPSED -lt $soak ]]; do
    sleep "$CHECK_INTERVAL"
    ELAPSED=$((ELAPSED + CHECK_INTERVAL))

    # Error rate for canary track
    ERROR_RATE=$(query_prometheus \
      'rate(quorumproof_api_errors_total{track="canary"}[1m])')

    # p95 latency for canary track (convert s → ms)
    P95_S=$(query_prometheus \
      'histogram_quantile(0.95, rate(quorumproof_contract_invocation_duration_seconds_bucket{track="canary"}[1m]))')
    P95_MS=$(awk "BEGIN{printf \"%.0f\", $P95_S * 1000}")

    # Canary pod restarts (sign of OOM or crash-loop)
    RESTARTS=$(query_prometheus \
      'sum(kube_pod_container_status_restarts_total{namespace="'"$NAMESPACE"'",pod=~"'"$CANARY_DEPLOYMENT"'-.*"})')

    log "  [${ELAPSED}s/${soak}s] error_rate=${ERROR_RATE} p95=${P95_MS}ms restarts=${RESTARTS}"

    # Check error rate threshold
    if awk "BEGIN{exit !($ERROR_RATE > $error_threshold)}"; then
      log "FAIL: error rate ${ERROR_RATE} > threshold ${error_threshold}"
      cmd_rollback
      fail "Canary rolled back: error rate exceeded threshold."
    fi

    # Check p95 latency threshold
    if awk "BEGIN{exit !($P95_MS > $p95_ms)}"; then
      log "FAIL: p95 latency ${P95_MS}ms > threshold ${p95_ms}ms"
      cmd_rollback
      fail "Canary rolled back: p95 latency exceeded threshold."
    fi

    # Check for crash loops
    if awk "BEGIN{exit !($RESTARTS > 3)}"; then
      log "FAIL: canary pod restarts=${RESTARTS} > 3"
      cmd_rollback
      fail "Canary rolled back: too many pod restarts."
    fi
  done

  log "Soak period complete. All metrics within thresholds."
  log "Canary is healthy. Run 'promote --image ${CANARY_IMAGE}' to promote."
  notify "Canary soak complete for ${CANARY_IMAGE}. Ready to promote."
}

cmd_promote() {
  local image=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --image) image="${2:?}"; shift ;;
      *) fail "promote: unknown option $1" ;;
    esac
    shift
  done

  canary_exists || fail "No canary deployment found. Deploy canary first."

  # Auto-detect image from canary if not specified
  if [[ -z "$image" ]]; then
    image=$($KUBECTL get deployment "$CANARY_DEPLOYMENT" -n "$NAMESPACE" \
      -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null) \
      || fail "Could not detect canary image. Use --image."
  fi

  STABLE=$(stable_replicas)
  log "Promoting canary image ${image} to stable (${STABLE} replicas)..."

  # Roll stable deployment to the canary image
  $KUBECTL set image deployment/"$STABLE_DEPLOYMENT" \
    api-server="$image" \
    -n "$NAMESPACE"

  log "Waiting for stable rollout..."
  $KUBECTL rollout status deployment/"$STABLE_DEPLOYMENT" \
    -n "$NAMESPACE" \
    --timeout=600s \
    || fail "Stable rollout failed. Canary still running as fallback."

  # Delete canary (stable is now serving 100%)
  log "Deleting canary deployment..."
  $KUBECTL delete deployment "$CANARY_DEPLOYMENT" -n "$NAMESPACE" --ignore-not-found=true
  $KUBECTL delete service quorumproof-api-server-canary-direct -n "$NAMESPACE" --ignore-not-found=true

  log "Promotion complete. Stable is now running ${image}."
  notify "Canary promoted: ${image} is now stable in ${NAMESPACE}."
}

cmd_rollback() {
  log "Rolling back: deleting canary deployment..."

  if canary_exists; then
    $KUBECTL delete deployment "$CANARY_DEPLOYMENT" -n "$NAMESPACE" --ignore-not-found=true
    $KUBECTL delete service quorumproof-api-server-canary-direct -n "$NAMESPACE" --ignore-not-found=true
    log "Canary deleted. Stable deployment is now serving 100% of traffic."
    notify "Canary rolled back in ${NAMESPACE}. Stable deployment restored to 100%."
  else
    log "No canary deployment found. Nothing to roll back."
  fi
}

cmd_status() {
  echo ""
  hr
  echo "  QuorumProof Canary Deployment Status  —  namespace: ${NAMESPACE}"
  hr
  echo ""

  echo "Stable deployment:"
  $KUBECTL get deployment "$STABLE_DEPLOYMENT" -n "$NAMESPACE" \
    -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,READY:.status.readyReplicas,DESIRED:.spec.replicas' \
    2>/dev/null || echo "  Not found"
  echo ""

  echo "Canary deployment:"
  if canary_exists; then
    $KUBECTL get deployment "$CANARY_DEPLOYMENT" -n "$NAMESPACE" \
      -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,READY:.status.readyReplicas,DESIRED:.spec.replicas' \
      2>/dev/null
    STABLE_R=$(stable_replicas)
    CANARY_R=$($KUBECTL get deployment "$CANARY_DEPLOYMENT" -n "$NAMESPACE" \
      -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")
    TOTAL=$((STABLE_R + CANARY_R))
    PCT=$(awk "BEGIN{printf \"%.0f\", $CANARY_R / ($TOTAL) * 100}" 2>/dev/null || echo "?")
    echo ""
    echo "  Traffic split: ~${PCT}% canary / ~$((100 - PCT))% stable"
  else
    echo "  No canary deployment active."
  fi

  echo ""
  hr
}

# ── Entrypoint ────────────────────────────────────────────────────────────────
COMMAND="${1:-}"
shift || true

case "$COMMAND" in
  deploy)   cmd_deploy   "$@" ;;
  monitor)  cmd_monitor  "$@" ;;
  promote)  cmd_promote  "$@" ;;
  rollback) cmd_rollback "$@" ;;
  status)   cmd_status   "$@" ;;
  ""|help|--help|-h)
    cat <<'EOF'
Usage: canary_k8s.sh <command> [options]

Commands:
  deploy    --image IMAGE [--pct PCT]        Launch canary at PCT% traffic (default 10%)
  monitor   [--soak SEC] [--error-threshold N] [--p95-ms N]
                                             Monitor metrics; auto-rollback on breach
  promote   [--image IMAGE]                  Promote canary to 100% stable
  rollback                                   Delete canary immediately
  status                                     Show current canary state

Examples:
  ./scripts/canary_k8s.sh deploy --image quorumproof/api-server:v1.2.0 --pct 10
  ./scripts/canary_k8s.sh monitor --soak 300 --error-threshold 0.05 --p95-ms 2000
  ./scripts/canary_k8s.sh promote
  ./scripts/canary_k8s.sh rollback
  ./scripts/canary_k8s.sh status
EOF
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    echo "Run '$0 --help' for usage." >&2
    exit 1
    ;;
esac
