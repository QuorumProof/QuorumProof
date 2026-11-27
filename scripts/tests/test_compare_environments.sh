#!/usr/bin/env bash
# scripts/tests/test_compare_environments.sh — Tests for scripts/compare_environments.sh
#
# Runs the real comparison tool against fixture environment snapshots inside a
# throwaway repo tree. Covers clean parity, RPC/passphrase/frontend drift,
# cross-snapshot inconsistencies, report files, and argument handling.
#
# Run with: ./scripts/tests/test_compare_environments.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
COMPARE_SCRIPT="$ROOT_DIR/compare_environments.sh"
PARITY_SCRIPT="$ROOT_DIR/check_env_parity.sh"

PASS=0
FAIL=0

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

FIXTURE_REPO="$WORK_DIR/repo"
ENV_DIR="$FIXTURE_REPO/environments"
CONTRACT_ID="C$(printf 'A%.0s' {1..55})"

reset_repo() {
  rm -rf "$FIXTURE_REPO"
  mkdir -p "$FIXTURE_REPO/scripts" "$ENV_DIR"
  cp "$COMPARE_SCRIPT" "$FIXTURE_REPO/scripts/compare_environments.sh"
  cp "$PARITY_SCRIPT" "$FIXTURE_REPO/scripts/check_env_parity.sh"
  chmod +x "$FIXTURE_REPO/scripts/compare_environments.sh" \
           "$FIXTURE_REPO/scripts/check_env_parity.sh"

  cat > "$FIXTURE_REPO/environments.toml" <<'TOML'
[testnet]
network_passphrase = "Test SDF Network ; September 2015"
rpc_url = "https://soroban-testnet.stellar.org"

[mainnet]
network_passphrase = "Public Global Stellar Network ; September 2015"
rpc_url = "https://mainnet.sorobanrpc.com"
TOML

  cat > "$FIXTURE_REPO/.env.example" <<EOF
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
CONTRACT_QUORUM_PROOF=$CONTRACT_ID
CONTRACT_SBT_REGISTRY=$CONTRACT_ID
CONTRACT_ZK_VERIFIER=$CONTRACT_ID
EOF
}

write_valid_snapshot() {
  local name="$1" network="$2" rpc="$3" passphrase="$4"
  cat > "$ENV_DIR/$name.env" <<EOF
STELLAR_NETWORK=$network
STELLAR_RPC_URL=$rpc
STELLAR_NETWORK_PASSPHRASE=$passphrase
CONTRACT_QUORUM_PROOF=$CONTRACT_ID
CONTRACT_SBT_REGISTRY=$CONTRACT_ID
CONTRACT_ZK_VERIFIER=$CONTRACT_ID
VITE_STELLAR_NETWORK=$network
VITE_STELLAR_RPC_URL=$rpc
VITE_CONTRACT_QUORUM_PROOF=$CONTRACT_ID
VITE_CONTRACT_SBT_REGISTRY=$CONTRACT_ID
VITE_CONTRACT_ZK_VERIFIER=$CONTRACT_ID
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100
HMAC_SIGNING_SECRET=shared-secret
BRIDGE_HMAC_SECRET=bridge-secret
EOF
}

write_valid_snapshots() {
  write_valid_snapshot "testnet" "testnet" \
    "https://soroban-testnet.stellar.org" "Test SDF Network ; September 2015"
  write_valid_snapshot "mainnet" "mainnet" \
    "https://mainnet.sorobanrpc.com" "Public Global Stellar Network ; September 2015"
}

write_drift_snapshots() {
  write_valid_snapshot "testnet" "testnet" \
    "https://wrong.example.com" "Wrong Passphrase"
  sed -i 's/^VITE_STELLAR_NETWORK=.*/VITE_STELLAR_NETWORK=mainnet/' \
    "$ENV_DIR/testnet.env"
  sed -i 's/^VITE_STELLAR_RPC_URL=.*/VITE_STELLAR_RPC_URL=https:\/\/wrong.example.com/' \
    "$ENV_DIR/testnet.env"
  sed -i 's/^RATE_LIMIT_MAX=.*/RATE_LIMIT_MAX=100/' "$ENV_DIR/testnet.env"

  write_valid_snapshot "mainnet" "mainnet" \
    "https://mainnet.sorobanrpc.com" "Public Global Stellar Network ; September 2015"
  sed -i 's/^RATE_LIMIT_MAX=.*/RATE_LIMIT_MAX=200/' "$ENV_DIR/mainnet.env"
}

run_compare() {
  "$FIXTURE_REPO/scripts/compare_environments.sh" "$@" \
    > "$WORK_DIR/stdout.log" 2>"$WORK_DIR/stderr.log"
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

assert_status() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    echo "  ok - $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL - $desc (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== test_compare_environments.sh ==="

# ── Test 1: two valid snapshots are reported as in parity ───────────────────
reset_repo
write_valid_snapshots
run_compare
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "valid snapshots exit 0" 0 "$status"
assert_contains "both snapshots discovered" "Found 2 snapshot file(s):" "$out"
assert_contains "testnet is clean" "✓ No drift detected for testnet" "$out"
assert_contains "mainnet is clean" "✓ No drift detected for mainnet" "$out"
assert_contains "shared vars are consistent" \
  "✓ Shared config vars are consistent across all snapshots" "$out"
assert_contains "grand summary reports parity" "✓ All environments are in parity." "$out"

# ── Test 2: RPC, passphrase, frontend/backend, and cross-snapshot drift ─────
reset_repo
write_drift_snapshots
run_compare
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "drift without --fail-on-drift exits 0" 0 "$status"
assert_contains "RPC mismatch detected" \
  "RPC URL mismatch: snapshot has \"https://wrong.example.com\"" "$out"
assert_contains "passphrase mismatch detected" \
  "Passphrase mismatch for testnet" "$out"
assert_contains "frontend/backend mismatch detected" \
  "Frontend/backend mismatch: STELLAR_NETWORK=\"testnet\" vs VITE_STELLAR_NETWORK=\"mainnet\"" "$out"
assert_contains "cross-snapshot inconsistency detected" \
  "INCONSISTENT: RATE_LIMIT_MAX differs across snapshots" "$out"
assert_contains "total drift counted" "Total drift issues found: 4" "$out"
assert_not_contains "no false parity claim" "All environments are in parity." "$out"

# ── Test 3: --fail-on-drift turns drift into a non-zero exit ────────────────
run_compare --fail-on-drift
status=$?
err=$(cat "$WORK_DIR/stderr.log")
assert_status "--fail-on-drift exits 1 on drift" 1 "$status"
assert_contains "--fail-on-drift explains the exit" \
  "Exiting with status 1 (--fail-on-drift is set and drift was found)." "$err"

# ── Test 4: text summary reports are written per snapshot ───────────────────
REPORT_DIR="$WORK_DIR/reports-text"
run_compare --report-dir "$REPORT_DIR"
status=$?
assert_status "text report run exits 0" 0 "$status"
if [[ -f "$REPORT_DIR/testnet-summary.text" && -f "$REPORT_DIR/mainnet-summary.text" ]]; then
  echo "  ok - per-snapshot text summaries created"
  PASS=$((PASS + 1))
  testnet_report=$(cat "$REPORT_DIR/testnet-summary.text")
  mainnet_report=$(cat "$REPORT_DIR/mainnet-summary.text")
  assert_contains "testnet summary drift count" "Drift count: 3" "$testnet_report"
  assert_contains "testnet summary RPC issue" "RPC URL mismatch" "$testnet_report"
  assert_contains "testnet summary passphrase issue" "Passphrase mismatch" "$testnet_report"
  assert_contains "testnet summary frontend issue" "Frontend/backend mismatch" "$testnet_report"
  assert_contains "mainnet summary has no drift" "Drift count: 0" "$mainnet_report"
  assert_contains "mainnet summary lists no issues" "(none)" "$mainnet_report"
else
  echo "  FAIL - per-snapshot text summaries not created"
  FAIL=$((FAIL + 1))
fi
if [[ -f "$REPORT_DIR/testnet-parity.text" && -f "$REPORT_DIR/mainnet-parity.text" ]]; then
  echo "  ok - parity detail reports created"
  PASS=$((PASS + 1))
else
  echo "  FAIL - parity detail reports not created"
  FAIL=$((FAIL + 1))
fi

# ── Test 5: JSON summary reports are machine-readable ───────────────────────
JSON_REPORT_DIR="$WORK_DIR/reports-json"
run_compare --format json --report-dir "$JSON_REPORT_DIR"
status=$?
assert_status "JSON report run exits 0" 0 "$status"
if [[ -f "$JSON_REPORT_DIR/testnet-summary.json" ]] && jq -e '
    .snapshot == "testnet" and
    .drift_count == 3 and
    (.issues | length == 3)
  ' "$JSON_REPORT_DIR/testnet-summary.json" >/dev/null 2>&1; then
  echo "  ok - testnet JSON summary is valid"
  PASS=$((PASS + 1))
else
  echo "  FAIL - testnet JSON summary missing or malformed"
  FAIL=$((FAIL + 1))
fi
if [[ -f "$JSON_REPORT_DIR/mainnet-summary.json" ]] && jq -e '
    .snapshot == "mainnet" and
    .drift_count == 0 and
    (.issues | length == 0)
  ' "$JSON_REPORT_DIR/mainnet-summary.json" >/dev/null 2>&1; then
  echo "  ok - mainnet JSON summary is valid"
  PASS=$((PASS + 1))
else
  echo "  FAIL - mainnet JSON summary missing or malformed"
  FAIL=$((FAIL + 1))
fi

# ── Test 6: --envs restricts the comparison to requested snapshots ──────────
reset_repo
write_valid_snapshots
run_compare --envs testnet
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "--envs exits 0 for valid snapshot" 0 "$status"
assert_contains "--envs reports one snapshot" "Found 1 snapshot file(s):" "$out"
assert_contains "--envs compares testnet" "✓ No drift detected for testnet" "$out"
assert_contains "--envs counts one snapshot" "Snapshots compared: 1" "$out"
assert_not_contains "--envs skips mainnet" "━━━ mainnet" "$out"
assert_not_contains "--envs skips cross-snapshot check" "Cross-snapshot consistency" "$out"

# ── Test 7: a requested snapshot that does not exist fails ──────────────────
run_compare --envs nope
status=$?
err=$(cat "$WORK_DIR/stderr.log")
assert_status "missing snapshot exits non-zero" 1 "$status"
assert_contains "missing snapshot path is named" \
  "Snapshot not found: $ENV_DIR/nope.env" "$err"

# ── Test 8: an unknown network is flagged against environments.toml ─────────
reset_repo
write_valid_snapshot "testnet" "unknown" \
  "https://soroban-testnet.stellar.org" "Test SDF Network ; September 2015"
run_compare
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "unknown network exits 0 without --fail-on-drift" 0 "$status"
assert_contains "unknown network detected" \
  "Network 'unknown' not found in environments.toml" "$out"

# ── Test 9: an empty environments/ directory is handled gracefully ──────────
reset_repo
run_compare
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "empty environments directory exits 0" 0 "$status"
assert_contains "empty directory is reported" "No snapshot files found in $ENV_DIR" "$out"

# ── Test 10: a missing environments/ directory is created with guidance ─────
reset_repo
rm -rf "$ENV_DIR"
run_compare
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "missing environments directory exits 0" 0 "$status"
assert_contains "missing directory is reported" \
  "environments/ directory not found at $ENV_DIR" "$out"
assert_contains "directory creation is reported" "Created $ENV_DIR/" "$out"
if [[ -f "$ENV_DIR/README.md" ]]; then
  echo "  ok - environments README was created"
  PASS=$((PASS + 1))
else
  echo "  FAIL - environments README was not created"
  FAIL=$((FAIL + 1))
fi

# ── Test 11: invalid options are rejected ───────────────────────────────────
reset_repo
write_valid_snapshots
run_compare --format yaml
status=$?
err=$(cat "$WORK_DIR/stderr.log")
assert_status "invalid format exits non-zero" 1 "$status"
assert_contains "invalid format is explained" \
  "ERROR: --format must be 'text' or 'json'" "$err"

run_compare --bogus
status=$?
err=$(cat "$WORK_DIR/stderr.log")
assert_status "unknown option exits non-zero" 1 "$status"
assert_contains "unknown option is named" "ERROR: Unknown option: --bogus" "$err"

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
