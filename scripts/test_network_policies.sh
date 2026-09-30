#!/usr/bin/env bash
# scripts/test_network_policies.sh — Issue #1655: Network Policy testing.
#
# Validates that network policies are enforced correctly by running a series
# of connectivity tests from within the cluster using a temporary test pod.
#
# Tests:
#   1. API server is reachable from ingress-nginx namespace
#   2. API server is NOT reachable from an untrusted pod in the same namespace
#   3. API server can reach PostgreSQL on port 5432
#   4. API server can reach external HTTPS (Soroban RPC)
#   5. API server CANNOT reach other pods on arbitrary ports (lateral movement)
#   6. Prometheus can scrape API server metrics
#
# Usage:
#   ./scripts/test_network_policies.sh [--namespace NAMESPACE] [--dry-run]
#
# Requirements:
#   kubectl, access to the target cluster, network-policy CNI (Calico/Cilium/etc.)

set -euo pipefail

NAMESPACE="${NAMESPACE:-quorumproof}"
DRY_RUN=false
KUBECTL="${KUBECTL:-kubectl}"
TEST_POD_IMAGE="ghcr.io/nicolaka/netshoot:latest"
TIMEOUT=30
PASS=0
FAIL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="${2:?}"; shift ;;
    --dry-run)   DRY_RUN=true ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

log()  { echo "[$(date -u +%H:%M:%SZ)] $*"; }
pass() { log "  [PASS] $*"; PASS=$((PASS + 1)); }
fail() { log "  [FAIL] $*"; FAIL=$((FAIL + 1)); }
skip() { log "  [SKIP] $*"; }

hr() { printf '%0.s─' {1..70}; echo; }

if $DRY_RUN; then
  log "DRY-RUN mode: printing test plan only, no pods launched."
  echo ""
  echo "Network Policy Test Plan for namespace: ${NAMESPACE}"
  hr
  echo "  1. Ingress: api-server reachable from ingress-nginx"
  echo "  2. Isolation: api-server NOT reachable from untrusted pod in ${NAMESPACE}"
  echo "  3. Egress:   api-server can reach postgres:5432"
  echo "  4. Egress:   api-server can reach soroban-testnet.stellar.org:443"
  echo "  5. Isolation: api-server CANNOT reach arbitrary pod ports"
  echo "  6. Monitoring: Prometheus can scrape api-server :3001/metrics/events"
  hr
  exit 0
fi

require_cmd() { command -v "$1" &>/dev/null || { echo "Required: $1"; exit 1; }; }
require_cmd kubectl

log "Network Policy tests — namespace: ${NAMESPACE}"
hr

# ── Helper: run a command inside a temporary netshoot pod ─────────────────────
run_in_pod() {
  local pod_name="$1"; shift
  local ns="${1:-${NAMESPACE}}"; shift
  $KUBECTL run "$pod_name" \
    --image="$TEST_POD_IMAGE" \
    --namespace="$ns" \
    --restart=Never \
    --rm \
    --timeout="${TIMEOUT}s" \
    --quiet \
    -- "$@" 2>/dev/null
}

cleanup() {
  $KUBECTL delete pod --namespace="$NAMESPACE" -l "netpol-test=true" \
    --ignore-not-found=true --timeout=30s &>/dev/null || true
  $KUBECTL delete pod --namespace="ingress-nginx" -l "netpol-test=true" \
    --ignore-not-found=true --timeout=30s &>/dev/null || true
}
trap cleanup EXIT

API_SVC="quorumproof-api-server.${NAMESPACE}.svc.cluster.local"

# ── Test 1: Ingress from ingress-nginx allowed ────────────────────────────────
log "Test 1: API server reachable from ingress-nginx namespace"
if $KUBECTL get namespace ingress-nginx &>/dev/null; then
  RESULT=$(run_in_pod "netpol-test-ingress" "ingress-nginx" \
    curl -sf --max-time 5 "http://${API_SVC}:3001/health" 2>&1) && \
    pass "ingress-nginx → api-server:3001/health" || \
    fail "ingress-nginx → api-server:3001/health (expected ALLOWED)"
else
  skip "Test 1: ingress-nginx namespace not found (run in a full cluster)"
fi

# ── Test 2: Isolation — untrusted pod cannot reach api-server ─────────────────
log "Test 2: Untrusted pod in ${NAMESPACE} CANNOT reach api-server"
RESULT=$(run_in_pod "netpol-test-untrusted" "$NAMESPACE" \
  curl -sf --max-time 5 "http://${API_SVC}:3001/health" 2>&1) && \
  fail "Untrusted pod → api-server:3001 (expected BLOCKED but got through)" || \
  pass "Untrusted pod → api-server:3001 correctly BLOCKED"

# ── Test 3: Egress to PostgreSQL ──────────────────────────────────────────────
log "Test 3: API server pod can reach postgres:5432"
API_POD=$($KUBECTL get pod -n "$NAMESPACE" -l "app=quorumproof-api-server" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) || API_POD=""

if [[ -n "$API_POD" ]]; then
  PG_SVC="quorumproof-postgres.${NAMESPACE}.svc.cluster.local"
  $KUBECTL exec -n "$NAMESPACE" "$API_POD" -- \
    timeout 5 bash -c "echo > /dev/tcp/${PG_SVC}/5432" 2>/dev/null && \
    pass "api-server → postgres:5432 ALLOWED" || \
    fail "api-server → postgres:5432 (expected ALLOWED)"
else
  skip "Test 3: No api-server pod found in ${NAMESPACE}"
fi

# ── Test 4: Egress to Soroban RPC (HTTPS) ────────────────────────────────────
log "Test 4: API server can reach soroban-testnet.stellar.org:443"
if [[ -n "$API_POD" ]]; then
  $KUBECTL exec -n "$NAMESPACE" "$API_POD" -- \
    timeout 10 curl -sf --max-time 8 \
    "https://soroban-testnet.stellar.org" -o /dev/null 2>/dev/null && \
    pass "api-server → soroban-testnet.stellar.org:443 ALLOWED" || \
    fail "api-server → soroban-testnet.stellar.org:443 (expected ALLOWED)"
else
  skip "Test 4: No api-server pod found"
fi

# ── Test 5: Lateral movement blocked ─────────────────────────────────────────
log "Test 5: API server CANNOT reach other pods on arbitrary ports"
if [[ -n "$API_POD" ]]; then
  # Try to reach the monitoring/Prometheus pod on a non-approved port
  PROM_SVC="prometheus.monitoring.svc.cluster.local"
  $KUBECTL exec -n "$NAMESPACE" "$API_POD" -- \
    timeout 5 curl -sf --max-time 4 \
    "http://${PROM_SVC}:9090/graph" -o /dev/null 2>/dev/null && \
    fail "api-server → prometheus:9090 on non-approved port (expected BLOCKED)" || \
    pass "api-server → prometheus:9090 via unauthorized path correctly BLOCKED"
else
  skip "Test 5: No api-server pod found"
fi

# ── Test 6: Prometheus scrapes api-server ────────────────────────────────────
log "Test 6: Prometheus can scrape api-server metrics"
PROM_POD=$($KUBECTL get pod -n monitoring -l "app=prometheus" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) || PROM_POD=""

if [[ -n "$PROM_POD" ]]; then
  $KUBECTL exec -n monitoring "$PROM_POD" -- \
    timeout 5 curl -sf --max-time 4 \
    "http://${API_SVC}:3001/metrics/events" -o /dev/null 2>/dev/null && \
    pass "prometheus → api-server:3001/metrics/events ALLOWED" || \
    fail "prometheus → api-server:3001/metrics/events (expected ALLOWED)"
else
  skip "Test 6: No Prometheus pod found in monitoring namespace"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
hr
log "Results: ${PASS} passed, ${FAIL} failed"
hr

if [[ $FAIL -gt 0 ]]; then
  log "Some tests failed. Review network policy configuration."
  log "See docs/network-policy.md for troubleshooting guidance."
  exit 1
fi

log "All network policy tests passed."
