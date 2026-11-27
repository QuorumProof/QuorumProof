#!/usr/bin/env bash
# scripts/tests/test_upgrade_rollback.sh — Tests for scripts/upgrade_rollback.sh
#
# Addresses #1839: test rollback against a fixture upgrade history.
#
# Exercises upgrade_rollback.sh against a stateful fake `stellar` CLI placed on
# PATH so no real network or Soroban RPC is required. The fake records every
# `invoke upgrade` call to a log file; tests assert on that log to verify the
# fixture upgrade history — specifically that a broken post-upgrade contract
# triggers a rollback `invoke upgrade --new_wasm_hash <pre-upgrade hash>`.
#
# This also guards the rollback path itself: upgrade_rollback.sh must reach
# Step 5 (rollback) on a post-upgrade failure rather than exiting in Step 4.
#
# Run with: ./scripts/tests/test_upgrade_rollback.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"        # scripts/
REPO_ROOT="$(dirname "$ROOT_DIR")"          # repo root (where snapshots land)
ROLLBACK_SCRIPT="$ROOT_DIR/upgrade_rollback.sh"

PASS=0
FAIL=0

# Contract IDs used by the tests. upgrade_rollback.sh writes
# .upgrade_snapshot_<contract_id>.json next to itself (the repo root); the
# trap cleans those up so no test artifacts are left behind.
CONTRACT_ROLLBACK="CROLLBACK0000000000000000000000000000000000000000000000"
CONTRACT_OK="COK000000000000000000000000000000000000000000000000000000000"
CONTRACT_PREFAIL="CPREFAIL000000000000000000000000000000000000000000000000"

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK_DIR"
  rm -f "$REPO_ROOT/.upgrade_snapshot_${CONTRACT_ROLLBACK}.json" \
        "$REPO_ROOT/.upgrade_snapshot_${CONTRACT_OK}.json" \
        "$REPO_ROOT/.upgrade_snapshot_${CONTRACT_PREFAIL}.json"
}
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); printf "  \033[32m✔\033[0m %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✘\033[0m %s\n" "$1"; }

# ── Fake `stellar` CLI ───────────────────────────────────────────────────────
# Behavior is driven by env vars set per test:
#   MOCK_PRE_HASH                 — wasm_hash returned by `contract info`
#   MOCK_NEW_HASH                 — hash returned by `contract upload`
#   MOCK_LOG                      — file to append every `invoke` call to
#   MOCK_STATE                    — file holding the get_state_metrics call count
#   MOCK_FAIL_STATE_METRICS_ON    — fail the Nth get_state_metrics call
#                                   (1 = pre-upgrade fails, 2 = post-upgrade fails,
#                                    0 = never fail)
make_stub() {
  local stub_dir="$WORK_DIR/bin"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/stellar" <<'STUB'
#!/usr/bin/env bash
# Fake `stellar` CLI for upgrade_rollback tests.
set -uo pipefail
args=("$@")
LOG="${MOCK_LOG:-/dev/null}"
STATE="${MOCK_STATE:-/tmp/upg_state.$$}"

case "${args[0]:-}" in
  keys)
    exit 0
    ;;
  contract)
    case "${args[1]:-}" in
      info)
        printf '{"wasm_hash": "%s"}\n' "${MOCK_PRE_HASH:-prehash}"
        ;;
      upload)
        printf '%s\n' "${MOCK_NEW_HASH:-newhash}"
        ;;
      invoke)
        fn="${args[-1]:-}"
        printf 'invoke fn=%s\n' "$fn" >> "$LOG"
        case "$fn" in
          get_version)
            exit 0
            ;;
          get_state_metrics)
            n=0; [[ -f "$STATE" ]] && n="$(cat "$STATE" 2>/dev/null || echo 0)"
            n=$((n + 1)); printf '%s\n' "$n" > "$STATE"
            fail_on="${MOCK_FAIL_STATE_METRICS_ON:-0}"
            if [[ "$fail_on" != "0" && "$n" -ge "$fail_on" ]]; then
              echo "error: contract unreachable (mock post-upgrade failure)" >&2
              exit 1
            fi
            exit 0
            ;;
          upgrade)
            hash=""
            for ((i = 0; i < ${#args[@]}; i++)); do
              if [[ "${args[$i]}" == "--new_wasm_hash" ]]; then
                hash="${args[$((i + 1))]:-}"; break
              fi
            done
            printf 'upgrade new_wasm_hash=%s\n' "$hash" >> "$LOG"
            exit 0
            ;;
          *)
            exit 0
            ;;
        esac
        ;;
    esac
    ;;
esac
exit 0
STUB
  chmod +x "$stub_dir/stellar"
  echo "$stub_dir"
}

STUB_BIN="$(make_stub)"
NEW_WASM="$WORK_DIR/fake.wasm"; printf '\x00asm\x01\x00\x00\x00' > "$NEW_WASM"

run_upgrade_rollback() {
  local contract_id="$1"
  (
    cd "$REPO_ROOT"
    PATH="$STUB_BIN:$PATH" \
    MOCK_LOG="$MOCK_LOG" MOCK_STATE="$MOCK_STATE" \
    MOCK_PRE_HASH="$MOCK_PRE_HASH" MOCK_NEW_HASH="$MOCK_NEW_HASH" \
    MOCK_FAIL_STATE_METRICS_ON="${MOCK_FAIL_STATE_METRICS_ON:-0}" \
    "$ROLLBACK_SCRIPT" "$contract_id" "$NEW_WASM" "SADMIN_TEST" \
      > "$WORK_DIR/run.out" 2>&1
  )
}

reset_fixture() {
  MOCK_LOG="$1"; MOCK_STATE="$2"
  : > "$MOCK_LOG"; rm -f "$MOCK_STATE"
  rm -f "$REPO_ROOT/.upgrade_snapshot_${CONTRACT_ROLLBACK}.json" \
        "$REPO_ROOT/.upgrade_snapshot_${CONTRACT_OK}.json" \
        "$REPO_ROOT/.upgrade_snapshot_${CONTRACT_PREFAIL}.json"
}

log_has()  { grep -qF "$1" "$MOCK_LOG"; }
log_lacks() { ! grep -qF "$1" "$MOCK_LOG"; }

echo "=== test_upgrade_rollback.sh ==="

# ── Test 1: broken post-upgrade contract → rollback to pre-upgrade hash ─────
echo "Test 1: rollback triggers when the post-upgrade contract is broken"
reset_fixture "$WORK_DIR/t1.log" "$WORK_DIR/t1.state"
MOCK_PRE_HASH="pre0aaa"
MOCK_NEW_HASH="new1bbb"
MOCK_FAIL_STATE_METRICS_ON=2   # 2nd get_state_metrics call == post-upgrade == broken
run_upgrade_rollback "$CONTRACT_ROLLBACK"; rc=$?

if [[ "$rc" -eq 1 ]]; then
  pass "broken post-upgrade exits 1 (rc=$rc)"
else
  fail "broken post-upgrade exited $rc (expected 1 — rollback path ends in failure)"
fi
if log_has "upgrade new_wasm_hash=new1bbb"; then
  pass "forward upgrade submitted with new hash"
else
  fail "forward upgrade with new hash not recorded"
fi
if log_has "upgrade new_wasm_hash=pre0aaa"; then
  pass "rollback submitted with pre-upgrade hash"
else
  fail "rollback to pre-upgrade hash not recorded — rollback path is unreachable (dead code)"
fi
if [[ ! -f "$REPO_ROOT/.upgrade_snapshot_${CONTRACT_ROLLBACK}.json" ]]; then
  pass "snapshot cleaned up after rollback"
else
  fail "snapshot file left behind after rollback"
fi

# ── Test 2: healthy post-upgrade contract → no rollback ─────────────────────
echo "Test 2: no rollback when the post-upgrade contract is healthy"
reset_fixture "$WORK_DIR/t2.log" "$WORK_DIR/t2.state"
MOCK_PRE_HASH="pre0aaa"
MOCK_NEW_HASH="new1bbb"
MOCK_FAIL_STATE_METRICS_ON=0   # never fail
run_upgrade_rollback "$CONTRACT_OK"; rc=$?

if [[ "$rc" -eq 0 ]]; then
  pass "healthy upgrade exits 0 (rc=$rc)"
else
  fail "healthy upgrade exited $rc (expected 0)"
fi
if log_has "upgrade new_wasm_hash=new1bbb"; then
  pass "forward upgrade submitted with new hash"
else
  fail "forward upgrade with new hash not recorded"
fi
if log_lacks "upgrade new_wasm_hash=pre0aaa"; then
  pass "no rollback submitted (pre-upgrade hash not re-applied)"
else
  fail "unexpected rollback recorded for a healthy upgrade"
fi
if [[ ! -f "$REPO_ROOT/.upgrade_snapshot_${CONTRACT_OK}.json" ]]; then
  pass "snapshot cleaned up after successful upgrade"
else
  fail "snapshot file left behind after successful upgrade"
fi

# ── Test 3: pre-upgrade failure → abort before any upgrade, no rollback ──────
echo "Test 3: pre-upgrade failure aborts before upgrading (no rollback)"
reset_fixture "$WORK_DIR/t3.log" "$WORK_DIR/t3.state"
MOCK_PRE_HASH="pre0aaa"
MOCK_NEW_HASH="new1bbb"
MOCK_FAIL_STATE_METRICS_ON=1   # 1st get_state_metrics call == pre-upgrade == broken
run_upgrade_rollback "$CONTRACT_PREFAIL"; rc=$?

if [[ "$rc" -eq 1 ]]; then
  pass "pre-upgrade failure aborts with exit 1 (rc=$rc)"
else
  fail "pre-upgrade failure exited $rc (expected 1)"
fi
if log_lacks "upgrade new_wasm_hash="; then
  pass "no upgrade submitted (aborted before Step 3)"
else
  fail "an upgrade was submitted despite pre-upgrade failure"
fi

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
