#!/usr/bin/env bash
# scripts/scaling_load_test.sh — Scaling load test and HPA validation
#
# Issue #1658 — Automated Scaling
#
# Drives the api-server under sustained load while watching the HPA, then
# validates that the replica count climbed and returned to baseline.
# Designed to be run in CI (see .github/workflows/ci.yml) or manually
# against a staging cluster.
#
# Usage:
#   ./scripts/scaling_load_test.sh [--namespace NS] [--duration-secs N]
#                                   [--rps N] [--dry-run]
#
# Environment (override via env or flags):
#   NAMESPACE        Kubernetes namespace (default: quorumproof)
#   LOAD_DURATION    Seconds to sustain load   (default: 120)
#   LOAD_RPS         Target requests per second (default: 500)
#   API_URL          Base URL of the api-server  (default: http://localhost:3001)
#
# Dependencies:
#   kubectl, hey (https://github.com/rakyll/hey) or curl, jq
#
# Exit codes:
#   0 — load test passed and HPA scaled as expected
#   1 — prerequisites missing
#   2 — HPA did not scale up during the load window
#   3 — HPA did not scale back down within the cool-down window

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# ── Defaults ──────────────────────────────────────────────────────────────────
NAMESPACE="${NAMESPACE:-quorumproof}"
LOAD_DURATION="${LOAD_DURATION:-120}"
LOAD_RPS="${LOAD_RPS:-500}"
API_URL="${API_URL:-http://localhost:3001}"
DRY_RUN=false

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --duration-secs) LOAD_DURATION="$2"; shift 2 ;;
    --rps) LOAD_RPS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Prerequisite checks ────────────────────────────────────────────────────────
check_prerequisites() {
  local missing=0
  for cmd in kubectl jq; do
    if ! command -v "$cmd" &>/dev/null; then
      error "Required command not found: $cmd"
      missing=1
    fi
  done

  # hey is preferred for load generation; fall back to a curl loop
  if ! command -v hey &>/dev/null; then
    warn "hey not found — falling back to curl-based load generation (less accurate)"
    USE_HEY=false
  else
    USE_HEY=true
  fi

  [[ $missing -eq 0 ]] || exit 1
}

# ── Helpers ────────────────────────────────────────────────────────────────────
hpa_current_replicas() {
  kubectl -n "$NAMESPACE" get hpa quorumproof-api-server \
    -o jsonpath='{.status.currentReplicas}' 2>/dev/null || echo "0"
}

hpa_desired_replicas() {
  kubectl -n "$NAMESPACE" get hpa quorumproof-api-server \
    -o jsonpath='{.status.desiredReplicas}' 2>/dev/null || echo "0"
}

wait_for_hpa_scale_up() {
  local min_replicas=2
  local deadline=$(( SECONDS + LOAD_DURATION + 60 ))
  info "Waiting for HPA to scale above $min_replicas replicas..."
  while [[ $SECONDS -lt $deadline ]]; do
    local current
    current=$(hpa_current_replicas)
    if [[ "$current" -gt "$min_replicas" ]]; then
      info "HPA scaled up to $current replicas ✓"
      return 0
    fi
    sleep 10
  done
  error "HPA did not scale up within $(( LOAD_DURATION + 60 )) seconds"
  return 1
}

wait_for_hpa_scale_down() {
  local target_replicas=2
  local cool_down=600  # HPA stabilisation window is 300s; allow 600s total
  local deadline=$(( SECONDS + cool_down ))
  info "Waiting for HPA to scale back down to $target_replicas replicas (max ${cool_down}s)..."
  while [[ $SECONDS -lt $deadline ]]; do
    local current
    current=$(hpa_current_replicas)
    if [[ "$current" -le "$target_replicas" ]]; then
      info "HPA scaled back down to $current replicas ✓"
      return 0
    fi
    sleep 15
  done
  error "HPA did not scale down within ${cool_down}s"
  return 1
}

# ── Load generation ────────────────────────────────────────────────────────────
generate_load() {
  local url="${API_URL}/health"
  info "Starting load: ${LOAD_RPS} req/s for ${LOAD_DURATION}s against ${url}"

  if $DRY_RUN; then
    warn "Dry-run mode: skipping actual load generation"
    return 0
  fi

  if $USE_HEY; then
    # hey -q rate-limits to LOAD_RPS, -z duration, -c concurrency
    hey -q "$LOAD_RPS" -z "${LOAD_DURATION}s" -c 50 "$url" | tail -20
  else
    # Fallback: fire LOAD_RPS * LOAD_DURATION requests using background curl
    local total=$(( LOAD_RPS * LOAD_DURATION ))
    local concurrency=50
    local count=0
    while [[ $count -lt $total ]]; do
      for (( i=0; i<concurrency && count<total; i++, count++ )); do
        curl -sf "${url}" -o /dev/null &
      done
      wait
      sleep 1
    done
  fi
}

# ── Record HPA snapshot ────────────────────────────────────────────────────────
record_hpa_status() {
  local label="$1"
  info "HPA status ($label):"
  kubectl -n "$NAMESPACE" get hpa quorumproof-api-server \
    -o custom-columns='REPLICAS:.status.currentReplicas,DESIRED:.status.desiredReplicas,MIN:.spec.minReplicas,MAX:.spec.maxReplicas,CPU:.status.currentMetrics[0].resource.current.averageUtilization' \
    2>/dev/null || warn "HPA not found (is it deployed?)"
}

# ── Main ───────────────────────────────────────────────────────────────────────
main() {
  info "=== QuorumProof Scaling Load Test ==="
  info "Namespace:  $NAMESPACE"
  info "Duration:   ${LOAD_DURATION}s at ${LOAD_RPS} req/s"
  info "API URL:    $API_URL"
  info "Dry run:    $DRY_RUN"
  echo

  check_prerequisites

  # ── Baseline snapshot ────────────────────────────────────────────────────────
  record_hpa_status "before load"
  local baseline_replicas
  baseline_replicas=$(hpa_current_replicas)
  info "Baseline replica count: $baseline_replicas"

  if $DRY_RUN; then
    info "Dry-run: would generate load, watch HPA scale up, then cool down."
    info "Dry-run complete — no assertions made."
    exit 0
  fi

  # ── Generate load in background, watch HPA ───────────────────────────────────
  generate_load &
  LOAD_PID=$!

  # Give metrics time to propagate (Prometheus scrape interval + HPA sync)
  sleep 30

  # ── Assert scale-up ─────────────────────────────────────────────────────────
  if ! wait_for_hpa_scale_up; then
    kill "$LOAD_PID" 2>/dev/null || true
    exit 2
  fi
  record_hpa_status "peak load"

  wait "$LOAD_PID" || true

  # ── Assert scale-down ────────────────────────────────────────────────────────
  if ! wait_for_hpa_scale_down; then
    exit 3
  fi
  record_hpa_status "after cool-down"

  info ""
  info "✅ Scaling load test passed"
  info "   Replicas scaled from ${baseline_replicas} during load, and returned to baseline after."
}

main "$@"
