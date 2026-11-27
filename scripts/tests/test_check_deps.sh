#!/usr/bin/env bash
# scripts/tests/test_check_deps.sh — Tests for scripts/check_deps.sh
#
# Runs the real check_deps.sh inside a throwaway repo tree containing fixture
# Cargo.toml, contracts/dependencies.toml, and deny.toml files. The script
# resolves its manifest relative to its own location, so copying it into the
# fixture tree keeps the real repository untouched.
#
# Run with: ./scripts/tests/test_check_deps.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CHECK_DEPS_SCRIPT="$ROOT_DIR/check_deps.sh"

PASS=0
FAIL=0

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

FIXTURE_REPO="$WORK_DIR/repo"

# ── Fixture repo ──────────────────────────────────────────────────────────────
reset_repo() {
  rm -rf "$FIXTURE_REPO"
  mkdir -p "$FIXTURE_REPO/scripts" \
           "$FIXTURE_REPO/contracts/quorum_proof"
  cp "$CHECK_DEPS_SCRIPT" "$FIXTURE_REPO/scripts/check_deps.sh"
  chmod +x "$FIXTURE_REPO/scripts/check_deps.sh"

  cat > "$FIXTURE_REPO/Cargo.toml" <<'TOML'
[workspace]
members = ["contracts/quorum_proof"]

[workspace.dependencies]
soroban-sdk = { version = "21.7" }
TOML

  cat > "$FIXTURE_REPO/contracts/dependencies.toml" <<'TOML'
[[contract]]
name    = "quorum_proof"
version = "0.1.0"

  [[contract.deps]]
  name        = "soroban-sdk"
  version     = "21.7"
  breaking_at = ">=22"
TOML

  cat > "$FIXTURE_REPO/contracts/quorum_proof/Cargo.toml" <<'TOML'
[package]
name = "quorum_proof"
version = "0.1.0"

[dependencies]
soroban-sdk = { workspace = true }
TOML

  cat > "$FIXTURE_REPO/deny.toml" <<'TOML'
[advisories]
allow = []
TOML
}

run_check_deps() {
  "$FIXTURE_REPO/scripts/check_deps.sh" > "$WORK_DIR/stdout.log" 2>"$WORK_DIR/stderr.log"
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

echo "=== test_check_deps.sh ==="

# ── Test 1: matching versions pass all checks ───────────────────────────────
reset_repo
run_check_deps
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "matching versions exit 0" 0 "$status"
assert_contains "workspace version matches manifest" \
  "[PASS] soroban-sdk workspace version (21.7) matches manifest (21.7)" "$out"
assert_contains "installed SDK is below the breaking threshold" \
  "[PASS] soroban-sdk below breaking version (22)" "$out"
assert_contains "summary reports no failures" "Results: 2 passed, 0 failed" "$out"

# ── Test 2: manifest/workspace version mismatch fails ───────────────────────
reset_repo
sed -i 's/version     = "21.7"/version     = "21.6"/' \
  "$FIXTURE_REPO/contracts/dependencies.toml"
run_check_deps
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "manifest mismatch exits non-zero" 1 "$status"
assert_contains "manifest mismatch is reported" \
  "[FAIL] soroban-sdk workspace version — Cargo.toml has 21.7, manifest declares 21.6" "$out"
assert_contains "manifest mismatch counted as failure" "1 failed" "$out"

# ── Test 3: a contract-local pin that differs from the manifest fails ───────
reset_repo
cat > "$FIXTURE_REPO/contracts/quorum_proof/Cargo.toml" <<'TOML'
[package]
name = "quorum_proof"
version = "0.1.0"

[dependencies]
soroban-sdk = { version = "20.0" }
TOML
run_check_deps
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "local pin mismatch exits non-zero" 1 "$status"
assert_contains "local pin mismatch is reported" \
  "[FAIL] quorum_proof soroban-sdk version — local pin 20.0 differs from manifest 21.7" "$out"

# ── Test 4: an SDK at or above the breaking threshold fails ─────────────────
reset_repo
sed -i 's/soroban-sdk = { version = "21.7" }/soroban-sdk = { version = "22.0" }/' \
  "$FIXTURE_REPO/Cargo.toml"
sed -i 's/version     = "21.7"/version     = "22.0"/' \
  "$FIXTURE_REPO/contracts/dependencies.toml"
run_check_deps
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "breaking version exits non-zero" 1 "$status"
assert_contains "breaking threshold is enforced" \
  "[FAIL] soroban-sdk below breaking version (22) — installed 22.0 meets or exceeds breaking threshold" "$out"

# ── Test 5: a fresh advisory exception is reported as OK ────────────────────
reset_repo
TODAY="$(date -u +%Y-%m-%d)"
cat > "$FIXTURE_REPO/deny.toml" <<TOML
[advisories]
allow = [
    # Added: $TODAY
    "RUSTSEC-2026-0258",
]
TOML
run_check_deps
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "fresh advisory exits 0" 0 "$status"
assert_contains "fresh advisory age is reported" \
  "[OK]   RUSTSEC-2026-0258 allowed for 0/90 days (added: $TODAY)" "$out"
assert_contains "no advisory age warnings for fresh entry" \
  "0 failed, 0 advisory age warning(s)" "$out"

# ── Test 6: an advisory exception older than 90 days warns without failing ──
reset_repo
cat > "$FIXTURE_REPO/deny.toml" <<'TOML'
[advisories]
allow = [
    # Added: 2020-01-01
    "RUSTSEC-2026-0258",
]
TOML
run_check_deps
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "stale advisory still exits 0 (warning only)" 0 "$status"
assert_contains "stale advisory is flagged as a warning" \
  "[WARN] RUSTSEC-2026-0258 has been allowed for" "$out"
assert_contains "stale advisory is counted" "1 advisory age warning(s)" "$out"

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
