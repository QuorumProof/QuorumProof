#!/usr/bin/env bash
# scripts/tests/test_failover.sh — Tests for scripts/failover.sh
#
# Exercises failover.sh against fake `curl` and `stellar` binaries (shell
# scripts resolved via PATH) so no real network or Soroban RPC is required.
# Each test configures a fake's behavior via env vars, runs the real script
# as a subprocess, and asserts on its stdout.
#
# Run with: ./scripts/tests/test_failover.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
FAILOVER_SCRIPT="$ROOT_DIR/failover.sh"

PASS=0
FAIL=0

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# ── Fake `curl` ───────────────────────────────────────────────────────────────
# Used by check_endpoint. Behavior is controlled by STUB_SOROBAN_HEALTHY,
# STUB_HORIZON_HEALTHY and STUB_CURL_FAIL, read from the environment at
# invocation time. Distinguishes Soroban vs Horizon requests the same way
# failover.sh does: by whether "horizon" appears in the URL.
make_curl_stub() {
  local stub_dir="$WORK_DIR/bin_curl"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/curl" <<'STUB'
#!/usr/bin/env bash
url=""
for a in "$@"; do
  case "$a" in http*) url="$a" ;; esac
done

if [[ "${STUB_CURL_FAIL:-0}" == "1" ]]; then
  exit 1
fi

if [[ "$url" == *horizon* ]]; then
  if [[ "${STUB_HORIZON_HEALTHY:-0}" == "1" ]]; then
    echo '{"horizon_version":"22.0.0","history_latest_ledger":100}'
  else
    echo '{"error":"not found"}'
  fi
else
  if [[ "${STUB_SOROBAN_HEALTHY:-0}" == "1" ]]; then
    echo '{"jsonrpc":"2.0","id":1,"result":{"status":"healthy"}}'
  else
    echo '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}'
  fi
fi
STUB
  chmod +x "$stub_dir/curl"
  echo "$stub_dir"
}

# ── Fake `stellar` ────────────────────────────────────────────────────────────
# Used by query_credential_count (verify_consistency). Returns STUB_COUNT_A/B
# for whichever RPC URL matches STUB_RPC_A/STUB_RPC_B, failing instead when
# STUB_FAIL_A/STUB_FAIL_B is "1".
make_stellar_stub() {
  local stub_dir="$WORK_DIR/bin_stellar"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/stellar" <<'STUB'
#!/usr/bin/env bash
rpc=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "--rpc-url" ]]; then rpc="${args[$((i+1))]}"; fi
done

if [[ "$rpc" == "$STUB_RPC_A" ]]; then
  if [[ "${STUB_FAIL_A:-0}" == "1" ]]; then echo "error: RPC call failed" >&2; exit 1; fi
  echo "\"${STUB_COUNT_A:-0}\""
elif [[ "$rpc" == "$STUB_RPC_B" ]]; then
  if [[ "${STUB_FAIL_B:-0}" == "1" ]]; then echo "error: RPC call failed" >&2; exit 1; fi
  echo "\"${STUB_COUNT_B:-0}\""
else
  echo "error: unknown rpc $rpc" >&2
  exit 1
fi
STUB
  chmod +x "$stub_dir/stellar"
  echo "$stub_dir"
}

run_failover() {
  local subcommand="$1" stub_dir="$2"
  shift 2
  (
    cd "$WORK_DIR" && \
    PATH="$stub_dir:$PATH" \
    "$FAILOVER_SCRIPT" "$subcommand" "$@" > "$WORK_DIR/stdout.log" 2>"$WORK_DIR/stderr.log"
  )
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  ok - $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL - $desc (expected to find '$needle')"
    echo "         --- actual output ---"
    while IFS= read -r line; do echo "         $line"; done <<<"$haystack"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "  ok - $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL - $desc (did not expect to find '$needle')"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== test_failover.sh ==="

# ── Test 1: --check reports a healthy Soroban RPC + Horizon pair as reachable ─
# Fails today: check_endpoint curls "$endpoint/health", which is a real route
# on neither endpoint type, so this always reported "unreachable".
out=$(RPC_TESTNET="https://fake-soroban.test" \
      RPC_TESTNET_BACKUP="https://fake-horizon.test" \
      RPC_MAINNET="https://fake-soroban-2.test" \
      RPC_MAINNET_BACKUP="https://fake-horizon-2.test" \
      STUB_SOROBAN_HEALTHY=1 STUB_HORIZON_HEALTHY=1 \
      run_failover "--check" "$(make_curl_stub)"; cat "$WORK_DIR/stdout.log")
assert_contains "healthy testnet (soroban) reported reachable" "✓ testnet:" "$out"
assert_contains "healthy testnet-backup (horizon) reported reachable" "✓ testnet-backup:" "$out"
assert_contains "healthy mainnet (soroban) reported reachable" "✓ mainnet:" "$out"
assert_contains "healthy mainnet-backup (horizon) reported reachable" "✓ mainnet-backup:" "$out"
assert_not_contains "no endpoint reported unreachable" "unreachable" "$out"

# ── Test 2: --check reports a Soroban RPC endpoint that answers but isn't
# healthy (getHealth returns a JSON-RPC error) as unreachable ────────────────
out=$(RPC_TESTNET="https://fake-soroban.test" \
      RPC_TESTNET_BACKUP="https://fake-horizon.test" \
      STUB_SOROBAN_HEALTHY=0 STUB_HORIZON_HEALTHY=1 \
      run_failover "--check" "$(make_curl_stub)"; cat "$WORK_DIR/stdout.log")
assert_contains "unhealthy soroban getHealth reported unreachable" "✗ testnet: https://fake-soroban.test (unreachable)" "$out"

# ── Test 3: --check reports a genuinely unreachable endpoint (connection
# failure) as unreachable, not reachable ──────────────────────────────────────
out=$(RPC_TESTNET_BACKUP="https://fake-horizon.test" \
      STUB_CURL_FAIL=1 \
      run_failover "--check" "$(make_curl_stub)"; cat "$WORK_DIR/stdout.log")
assert_contains "connection failure reported unreachable" "✗ testnet-backup: https://fake-horizon.test (unreachable)" "$out"

# ── Test 4: --verify reports Consistent when both endpoints agree ────────────
out=$(CONTRACT_QUORUM_PROOF_TESTNET="CONTRACTID" \
      RPC_TESTNET="https://fake-a.test" RPC_TESTNET_BACKUP="https://fake-b.test" \
      STUB_RPC_A="https://fake-a.test" STUB_RPC_B="https://fake-b.test" \
      STUB_COUNT_A=10 STUB_COUNT_B=10 \
      run_failover "--verify" "$(make_stellar_stub)"; cat "$WORK_DIR/stdout.log")
assert_contains "matching counts report Consistent" "✓ Consistent" "$out"
assert_not_contains "matching counts do not report Inconsistent" "Inconsistent state detected" "$out"

# ── Test 5: --verify reports Inconsistent when counts genuinely diverge ──────
# Fails today: the state query always resolved to 0 on both sides via
# `jq ... || echo "0"`, so this could never be detected.
out=$(CONTRACT_QUORUM_PROOF_TESTNET="CONTRACTID" \
      RPC_TESTNET="https://fake-a.test" RPC_TESTNET_BACKUP="https://fake-b.test" \
      STUB_RPC_A="https://fake-a.test" STUB_RPC_B="https://fake-b.test" \
      STUB_COUNT_A=10 STUB_COUNT_B=17 \
      run_failover "--verify" "$(make_stellar_stub)"; cat "$WORK_DIR/stdout.log")
assert_contains "diverging counts report Inconsistent state detected" "✗ Inconsistent state detected" "$out"
assert_not_contains "diverging counts do not report Consistent" "✓ Consistent" "$out"

# ── Test 6: --verify surfaces an RPC failure as "could not verify", never as
# a matching count of 0 that reads as consistent ─────────────────────────────
out=$(CONTRACT_QUORUM_PROOF_TESTNET="CONTRACTID" \
      RPC_TESTNET="https://fake-a.test" RPC_TESTNET_BACKUP="https://fake-b.test" \
      STUB_RPC_A="https://fake-a.test" STUB_RPC_B="https://fake-b.test" \
      STUB_COUNT_A=10 STUB_FAIL_B=1 \
      run_failover "--verify" "$(make_stellar_stub)"; cat "$WORK_DIR/stdout.log")
assert_contains "RPC failure surfaced as UNKNOWN, not 0" "testnet-backup: UNKNOWN credentials" "$out"
assert_contains "RPC failure reports Could not verify" "? Could not verify" "$out"
assert_not_contains "RPC failure never reads as Consistent" "✓ Consistent" "$out"
assert_not_contains "RPC failure never reads as a false 0-count inconsistency label bypass" "Inconsistent state detected" "$out"

# ── Test 7: with both networks configured, each network's result only
# reflects its own two endpoints — no cross-network leakage or stale data
# carried over from the previous iteration ───────────────────────────────────
out=$(CONTRACT_QUORUM_PROOF_TESTNET="TESTCONTRACT" CONTRACT_QUORUM_PROOF_MAINNET="MAINCONTRACT" \
      RPC_TESTNET="https://fake-t.test" RPC_TESTNET_BACKUP="https://fake-tb.test" \
      RPC_MAINNET="https://fake-m.test" RPC_MAINNET_BACKUP="https://fake-mb.test" \
      STUB_RPC_A="https://fake-t.test" STUB_RPC_B="https://fake-tb.test" \
      STUB_COUNT_A=5 STUB_COUNT_B=5 \
      run_failover "--verify" "$(make_stellar_stub)"; cat "$WORK_DIR/stdout.log")
# testnet's own two endpoints (stubbed) should be Consistent...
assert_contains "testnet block reports Consistent from its own endpoints" "TESTCONTRACT):
      testnet-backup: 5 credentials
      testnet: 5 credentials
      ✓ Consistent" "$out"
# ...and mainnet (unstubbed RPC, real stellar not present) must report
# Could not verify using ONLY its own two endpoint lines - not testnet's.
mainnet_block=$(awk '/MAINCONTRACT\):/{flag=1} flag{print} /^$/{if(flag) exit}' <<<"$out")
assert_not_contains "mainnet block does not leak testnet's endpoint entries" "testnet:" "$mainnet_block"
assert_not_contains "mainnet block does not leak testnet-backup's entry" "testnet-backup:" "$mainnet_block"
assert_contains "mainnet block reports Could not verify on its own unreachable endpoints" "Could not verify" "$mainnet_block"

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
