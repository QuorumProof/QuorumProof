#!/usr/bin/env bash
# scripts/tests/test_check_env_parity.sh — Tests for scripts/check_env_parity.sh
#
# Runs the real parity checker against fixture env files inside a throwaway
# repo tree so the canonical environments.toml is controlled by the test.
# Covers parity, drift categories, report output, and exit-code behaviour.
#
# Run with: ./scripts/tests/test_check_env_parity.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PARITY_SCRIPT="$ROOT_DIR/check_env_parity.sh"

PASS=0
FAIL=0

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

FIXTURE_REPO="$WORK_DIR/repo"
ENV1="$WORK_DIR/env1.env"
ENV2="$WORK_DIR/env2.env"
CONTRACT_ID="C$(printf 'A%.0s' {1..55})"

reset_repo() {
  rm -rf "$FIXTURE_REPO"
  mkdir -p "$FIXTURE_REPO/scripts"
  cp "$PARITY_SCRIPT" "$FIXTURE_REPO/scripts/check_env_parity.sh"
  chmod +x "$FIXTURE_REPO/scripts/check_env_parity.sh"

  cat > "$FIXTURE_REPO/environments.toml" <<'TOML'
[testnet]
network_passphrase = "Test SDF Network ; September 2015"
rpc_url = "https://soroban-testnet.stellar.org"

[mainnet]
network_passphrase = "Public Global Stellar Network ; September 2015"
rpc_url = "https://mainnet.sorobanrpc.com"
TOML
}

write_parity_envs() {
  cat > "$ENV1" <<EOF
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
CONTRACT_QUORUM_PROOF=$CONTRACT_ID
CONTRACT_SBT_REGISTRY=$CONTRACT_ID
CONTRACT_ZK_VERIFIER=$CONTRACT_ID
RATE_LIMIT_MAX=100
EOF
  cp "$ENV1" "$ENV2"
}

write_drift_envs() {
  cat > "$ENV1" <<EOF
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://wrong.example.com
CONTRACT_QUORUM_PROOF=invalid
CONTRACT_SBT_REGISTRY=$CONTRACT_ID
CONTRACT_ZK_VERIFIER=
EXTRA_ONLY=1
SHARE_LINK_HMAC_SECRET=change-me
EOF
  cat > "$ENV2" <<EOF
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
CONTRACT_QUORUM_PROOF=$CONTRACT_ID
CONTRACT_SBT_REGISTRY=$CONTRACT_ID
CONTRACT_ZK_VERIFIER=$CONTRACT_ID
MISSING_KEY=value
SHARE_LINK_HMAC_SECRET=secret
EOF
}

run_parity() {
  "$FIXTURE_REPO/scripts/check_env_parity.sh" \
    --env1 "$ENV1" --env2 "$ENV2" "$@" \
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

echo "=== test_check_env_parity.sh ==="

# ── Test 1: identical, valid environments are reported as in parity ─────────
reset_repo
write_parity_envs
run_parity
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "parity exits 0" 0 "$status"
assert_contains "no missing keys" "✓ No missing keys" "$out"
assert_contains "no extra keys" "✓ No extra keys" "$out"
assert_contains "no placeholders" "✓ No placeholder values detected" "$out"
assert_contains "network is consistent" "✓ Network configuration is consistent" "$out"
assert_contains "contract formats are valid" "✓ All contract address formats look valid" "$out"
assert_contains "required vars are set" "✓ All required variables are set" "$out"
assert_contains "summary reports parity" "✓ No drift detected — environments are in parity." "$out"

# ── Test 2: every drift category is detected and counted ────────────────────
reset_repo
write_drift_envs
run_parity
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "drift without --fail-on-drift exits 0" 0 "$status"
assert_contains "missing key detected" "✗ MISSING: MISSING_KEY" "$out"
assert_contains "extra key detected" "⚠ EXTRA: EXTRA_ONLY" "$out"
assert_contains "placeholder detected" "⚠ PLACEHOLDER: SHARE_LINK_HMAC_SECRET" "$out"
assert_contains "RPC mismatch detected" "✗ NETWORK DRIFT: STELLAR_RPC_URL mismatch" "$out"
assert_contains "invalid contract format detected" "✗ INVALID FORMAT: CONTRACT_QUORUM_PROOF" "$out"
assert_contains "missing required var detected" "✗ REQUIRED MISSING: CONTRACT_ZK_VERIFIER" "$out"
assert_contains "drift total counted" "✗ 5 drift issue(s) found" "$out"
assert_contains "extra-key warning counted" "⚠ 1 warning(s) (extra keys)" "$out"
assert_not_contains "no false parity claim" "No drift detected" "$out"

# ── Test 3: --fail-on-drift turns drift into a non-zero exit ────────────────
run_parity --fail-on-drift
status=$?
err=$(cat "$WORK_DIR/stderr.log")
assert_status "--fail-on-drift exits 1 on drift" 1 "$status"
assert_contains "--fail-on-drift explains the exit" \
  "Exiting with status 1 (--fail-on-drift is set and drift was found)." "$err"

# ── Test 4: text report records the drift details ───────────────────────────
reset_repo
write_drift_envs
REPORT_TXT="$WORK_DIR/report.txt"
run_parity --report "$REPORT_TXT"
status=$?
assert_status "text report run exits 0" 0 "$status"
if [[ -f "$REPORT_TXT" ]]; then
  echo "  ok - text report file created"
  PASS=$((PASS + 1))
  report=$(cat "$REPORT_TXT")
  assert_contains "text report drift count" "drift_count: 5" "$report"
  assert_contains "text report warning count" "warning_count: 1" "$report"
  assert_contains "text report missing section" "=== Missing Keys (1) ===" "$report"
  assert_contains "text report missing entry" "  - MISSING_KEY" "$report"
else
  echo "  FAIL - text report file not created"
  FAIL=$((FAIL + 1))
fi

# ── Test 5: JSON report is machine-readable ─────────────────────────────────
REPORT_JSON="$WORK_DIR/report.json"
run_parity --format json --report "$REPORT_JSON"
status=$?
assert_status "JSON report run exits 0" 0 "$status"
if [[ -f "$REPORT_JSON" ]] && jq -e '
    .drift_count == 5 and
    .warning_count == 1 and
    .missing_keys == ["MISSING_KEY"] and
    .extra_keys == ["EXTRA_ONLY"] and
    (.placeholder_vars[0] | startswith("SHARE_LINK_HMAC_SECRET=")) and
    (.network_issues | length == 1) and
    (.contract_issues | length == 1) and
    (.required_missing[0] | startswith("CONTRACT_ZK_VERIFIER"))
  ' "$REPORT_JSON" >/dev/null 2>&1; then
  echo "  ok - JSON report contains all drift categories"
  PASS=$((PASS + 1))
else
  echo "  FAIL - JSON report missing or malformed"
  FAIL=$((FAIL + 1))
fi

# ── Test 6: VITE variables must mirror their backend counterparts ───────────
reset_repo
write_parity_envs
printf 'VITE_STELLAR_NETWORK=mainnet\n' >> "$ENV1"
run_parity
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "VITE mismatch exits 0 without --fail-on-drift" 0 "$status"
assert_contains "VITE network mismatch detected" \
  "VITE_STELLAR_NETWORK=mainnet does not match STELLAR_NETWORK=testnet" "$out"
assert_contains "VITE mismatch counted" "✗ 1 drift issue(s) found" "$out"

# ── Test 7: a network absent from environments.toml is flagged ──────────────
reset_repo
write_parity_envs
sed -i 's/^STELLAR_NETWORK=.*/STELLAR_NETWORK=futurenet/' "$ENV1"
run_parity
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "unknown network exits 0 without --fail-on-drift" 0 "$status"
assert_contains "unknown network detected" \
  "STELLAR_NETWORK=futurenet is not defined in environments.toml" "$out"

# ── Test 8: missing env file fails clearly ──────────────────────────────────
reset_repo
write_parity_envs
"$FIXTURE_REPO/scripts/check_env_parity.sh" \
  --env1 "$WORK_DIR/nope.env" --env2 "$ENV2" \
  > "$WORK_DIR/stdout.log" 2>"$WORK_DIR/stderr.log"
status=$?
err=$(cat "$WORK_DIR/stderr.log")
assert_status "missing env1 exits non-zero" 1 "$status"
assert_contains "missing env1 is named" "env1 file not found: $WORK_DIR/nope.env" "$err"

# ── Test 9: invalid options are rejected ────────────────────────────────────
reset_repo
write_parity_envs
run_parity --format yaml
status=$?
err=$(cat "$WORK_DIR/stderr.log")
assert_status "invalid format exits non-zero" 1 "$status"
assert_contains "invalid format is explained" \
  "ERROR: --format must be 'text' or 'json'" "$err"

run_parity --bogus
status=$?
err=$(cat "$WORK_DIR/stderr.log")
assert_status "unknown option exits non-zero" 1 "$status"
assert_contains "unknown option is named" "ERROR: Unknown option: --bogus" "$err"

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
