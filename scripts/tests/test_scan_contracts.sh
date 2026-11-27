#!/usr/bin/env bash
# scripts/tests/test_scan_contracts.sh — Tests for scripts/scan_contracts.sh
#
# Addresses #1839: test that the scanner fails on a known-vulnerable fixture.
#
# Runs scan_contracts.sh against fixture contract trees pointed at via the
# CONTRACT_SRC_DIR env override (see scan_contracts.sh) so the real contracts/
# tree is never scanned during the test:
#   1. A vulnerable fixture (unsafe block + hardcoded Stellar address) must
#      exit non-zero with CRITICAL findings.
#   2. A clean fixture must exit zero with no CRITICAL findings.
#   3. A bare unwrap() outside a test module is WARN, not a failure.
#
# Run with: ./scripts/tests/test_scan_contracts.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SCAN_SCRIPT="$ROOT_DIR/scan_contracts.sh"

PASS=0
FAIL=0

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); printf "  \033[32m✔\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✘\033[0m %s\n" "$1"; }

# Build a fixture contract tree under $1/contracts and run the scanner against
# that fixture directory (CONTRACT_SRC_DIR overrides scan_contracts.sh's
# default of the repo contracts/ tree). Captures the exit code.
run_scan() {
  local fixture_dir="$1"
  CONTRACT_SRC_DIR="$fixture_dir" "$SCAN_SCRIPT" > "$WORK_DIR/scan.out" 2>&1
}

# A 56-char Stellar-looking public key literal: "G" + 55 base32 chars.
# The scanner flags any "G[A-Z2-7]{55}" string literal as a hardcoded address.
hardcoded_address() {
  printf 'G'; printf 'A%.0s' {1..55}
}

echo "=== test_scan_contracts.sh ==="

# ── Test 1: known-vulnerable fixture → exit 1 with CRITICAL findings ─────────
echo "Test 1: scanner fails on a known-vulnerable fixture"
VULN_DIR="$WORK_DIR/vuln/contracts"
mkdir -p "$VULN_DIR"
ADDR="$(hardcoded_address)"
cat > "$VULN_DIR/vault.rs" <<RS
// Fixture: intentionally vulnerable contract source (issue #1839).
pub fn admin() -> u32 {
    let key = "$ADDR"; // hardcoded admin address
    unsafe { () }      // unsafe block
    0
}
RS
run_scan "$VULN_DIR"; rc=$?
if [[ "$rc" -ne 0 ]]; then
  pass "vulnerable fixture exits non-zero (rc=$rc)"
else
  fail "vulnerable fixture exited 0 (expected non-zero)"
fi
if grep -q '\[CRITICAL\]' "$WORK_DIR/scan.out"; then
  pass "vulnerable fixture reports a CRITICAL finding"
else
  fail "vulnerable fixture reported no CRITICAL finding"
fi
if grep -q 'unsafe block' "$WORK_DIR/scan.out" && grep -q 'hardcoded address' "$WORK_DIR/scan.out"; then
  pass "vulnerable fixture reports both unsafe block and hardcoded address"
else
  fail "vulnerable fixture missing unsafe block or hardcoded address report"
fi

# ── Test 2: clean fixture → exit 0, no CRITICAL findings ─────────────────────
echo "Test 2: scanner passes on a clean fixture"
CLEAN_DIR="$WORK_DIR/clean/contracts"
mkdir -p "$CLEAN_DIR"
cat > "$CLEAN_DIR/vault.rs" <<'RS'
// Fixture: clean contract source — no unsafe, no hardcoded address.
pub fn version() -> u32 { 42 }
RS
run_scan "$CLEAN_DIR"; rc=$?
if [[ "$rc" -eq 0 ]]; then
  pass "clean fixture exits 0"
else
  fail "clean fixture exited non-zero (rc=$rc, expected 0)"
fi
if ! grep -q '\[CRITICAL\]' "$WORK_DIR/scan.out"; then
  pass "clean fixture reports no CRITICAL finding"
else
  fail "clean fixture reported an unexpected CRITICAL finding"
fi

# ── Test 3: bare unwrap() outside tests is WARN, not a failure ────────────────
echo "Test 3: bare unwrap() outside tests is a warning, not a failure"
WARN_DIR="$WORK_DIR/warn/contracts"
mkdir -p "$WARN_DIR"
cat > "$WARN_DIR/wallet.rs" <<'RS'
// Fixture: bare unwrap() in a non-test file — WARN only, must not fail.
pub fn balance() -> u32 { Some(1).unwrap() }
RS
run_scan "$WARN_DIR"; rc=$?
if [[ "$rc" -eq 0 ]]; then
  pass "bare unwrap exits 0 (warning only, not a failure)"
else
  fail "bare unwrap exited non-zero (rc=$rc, expected 0 — WARN must not fail)"
fi
if grep -q '\[WARN\]' "$WORK_DIR/scan.out" && grep -q 'bare unwrap' "$WORK_DIR/scan.out"; then
  pass "bare unwrap reported as WARN"
else
  fail "bare unwrap not reported as WARN"
fi
if ! grep -q '\[CRITICAL\]' "$WORK_DIR/scan.out"; then
  pass "bare unwrap reports no CRITICAL finding (downgraded to WARN)"
else
  fail "bare unwrap reported an unexpected CRITICAL finding"
fi

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
