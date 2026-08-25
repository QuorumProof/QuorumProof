#!/usr/bin/env bash
# scripts/tests/test_reconcile_state.sh — Tests for scripts/reconcile_state.sh
#
# Exercises reconcile_state.sh against a fake `stellar` CLI (a shell function
# resolved via PATH) so no real network or Soroban RPC is required. Each test
# configures the fake to return specific counter values or to fail outright,
# runs the real script as a subprocess, and asserts on its exit code and the
# JSON report it writes.
#
# Run with: ./scripts/tests/test_reconcile_state.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RECONCILE_SCRIPT="$ROOT_DIR/reconcile_state.sh"
# reconcile_state.sh resolves its own ROOT_DIR from its script path (not cwd)
# and always writes reconcile_report_*.json there — i.e. the repo root.
REPO_ROOT="$(dirname "$ROOT_DIR")"

PASS=0
FAIL=0

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK_DIR"
  rm -f "$REPO_ROOT"/reconcile_report_*.json
}
trap cleanup EXIT

# ── Fake `stellar` CLI ────────────────────────────────────────────────────────
# Writes a fake `stellar` binary that returns STUB_CRED_A/STUB_SLICE_A for
# contract $STUB_CONTRACT_A and STUB_CRED_B/STUB_SLICE_B for $STUB_CONTRACT_B,
# failing instead when STUB_FAIL_A/STUB_FAIL_B is "1" — all read from the
# environment at invocation time so each test just sets the env vars it needs.
make_stub() {
  local stub_dir="$WORK_DIR/bin"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/stellar" <<'STUB'
#!/usr/bin/env bash
# Fake `stellar` CLI for tests. Reads behavior from env vars set by the test.
contract=""
fn=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "--id" ]]; then
    contract="${args[$((i+1))]}"
  fi
done
fn="${args[-1]}"

if [[ "$contract" == "$STUB_CONTRACT_A" ]]; then
  if [[ "$STUB_FAIL_A" == "1" ]]; then
    echo "error: RPC call failed" >&2
    exit 1
  fi
  if [[ "$fn" == "get_credential_count" ]]; then echo "\"$STUB_CRED_A\""; else echo "\"$STUB_SLICE_A\""; fi
elif [[ "$contract" == "$STUB_CONTRACT_B" ]]; then
  if [[ "$STUB_FAIL_B" == "1" ]]; then
    echo "error: RPC call failed" >&2
    exit 1
  fi
  if [[ "$fn" == "get_credential_count" ]]; then echo "\"$STUB_CRED_B\""; else echo "\"$STUB_SLICE_B\""; fi
else
  echo "error: unknown contract $contract" >&2
  exit 1
fi
STUB
  chmod +x "$stub_dir/stellar"
  echo "$stub_dir"
}

run_reconcile() {
  local contract_a="$1" contract_b="$2" stub_dir="$3"
  (
    cd "$WORK_DIR" && \
    PATH="$stub_dir:$PATH" \
    STUB_CONTRACT_A="$contract_a" STUB_CONTRACT_B="$contract_b" \
    STUB_CRED_A="${STUB_CRED_A:-0}" STUB_SLICE_A="${STUB_SLICE_A:-0}" \
    STUB_CRED_B="${STUB_CRED_B:-0}" STUB_SLICE_B="${STUB_SLICE_B:-0}" \
    STUB_FAIL_A="${STUB_FAIL_A:-0}" STUB_FAIL_B="${STUB_FAIL_B:-0}" \
    "$RECONCILE_SCRIPT" "$contract_a" "$contract_b" > "$WORK_DIR/stdout.log" 2>&1
  )
}

latest_report() { ls -t "$REPO_ROOT"/reconcile_report_*.json 2>/dev/null | head -n1; }

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ok - $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL - $desc (expected='$expected' actual='$actual')"
    FAIL=$((FAIL + 1))
  fi
}

reset_stubs() {
  unset STUB_CRED_A STUB_SLICE_A STUB_CRED_B STUB_SLICE_B STUB_FAIL_A STUB_FAIL_B
  rm -f "$REPO_ROOT"/reconcile_report_*.json "$WORK_DIR/stdout.log"
}

echo "=== test_reconcile_state.sh ==="

# ── Test 1: matching counters on two reachable instances → consistent ────────
reset_stubs
STUB_CRED_A=10 STUB_SLICE_A=5 STUB_CRED_B=10 STUB_SLICE_B=5 \
  run_reconcile "contractA" "contractB" "$(make_stub)"
exit_code=$?
report="$(latest_report)"
assert_eq "consistent counters exit 0" "0" "$exit_code"
assert_eq "consistent report status" "consistent" "$(jq -r .status "$report")"
assert_eq "consistent report inconsistencies=0" "0" "$(jq -r .inconsistencies "$report")"
assert_eq "consistent report unverified=0" "0" "$(jq -r .unverified "$report")"

# ── Test 2: genuine mismatch on two reachable instances → detected ───────────
reset_stubs
STUB_CRED_A=10 STUB_SLICE_A=5 STUB_CRED_B=12 STUB_SLICE_B=5 \
  run_reconcile "contractA" "contractB" "$(make_stub)"
exit_code=$?
report="$(latest_report)"
assert_eq "mismatch exits 1" "1" "$exit_code"
assert_eq "mismatch report status" "inconsistent" "$(jq -r .status "$report")"
assert_eq "mismatch report inconsistencies=1" "1" "$(jq -r .inconsistencies "$report")"
assert_eq "mismatch report unverified=0" "0" "$(jq -r .unverified "$report")"
assert_eq "mismatch report cred_a=10" "10" "$(jq -r .instance_a.credential_count "$report")"
assert_eq "mismatch report cred_b=12" "12" "$(jq -r .instance_b.credential_count "$report")"

# ── Test 3: both instances unreachable → NOT reported as consistent ──────────
reset_stubs
STUB_FAIL_A=1 STUB_FAIL_B=1 \
  run_reconcile "contractA" "contractB" "$(make_stub)"
exit_code=$?
report="$(latest_report)"
assert_eq "total outage exits 2 (unverifiable, not 0)" "2" "$exit_code"
assert_eq "total outage report status is unverifiable" "unverifiable" "$(jq -r .status "$report")"
assert_eq "total outage inconsistencies=0 (not falsely flagged as data mismatch)" "0" "$(jq -r .inconsistencies "$report")"
assert_eq "total outage unverified=2 (both metrics unverifiable)" "2" "$(jq -r .unverified "$report")"
assert_eq "total outage credential_count is null, not 0" "null" "$(jq -r '.instance_a.credential_count' "$report")"
grep -q "Reconciliation complete. No inconsistencies found." "$WORK_DIR/stdout.log" && {
  echo "  FAIL - total outage log must not claim 'No inconsistencies found'"
  FAIL=$((FAIL + 1))
} || {
  echo "  ok - total outage log does not claim 'No inconsistencies found'"
  PASS=$((PASS + 1))
}

# ── Test 4: only instance A unreachable → asymmetric failure is unverifiable ─
reset_stubs
STUB_FAIL_A=1 STUB_CRED_B=10 STUB_SLICE_B=5 \
  run_reconcile "contractA" "contractB" "$(make_stub)"
exit_code=$?
report="$(latest_report)"
assert_eq "asymmetric failure exits 2" "2" "$exit_code"
assert_eq "asymmetric failure report status is unverifiable" "unverifiable" "$(jq -r .status "$report")"
assert_eq "asymmetric failure unverified=2" "2" "$(jq -r .unverified "$report")"

# ── Test 5: mismatch on one metric + RPC failure on another → both surfaced ──
reset_stubs
# credential_count mismatches (10 vs 12); slice_count query for B fails.
stub_dir="$WORK_DIR/bin_mixed"
mkdir -p "$stub_dir"
cat > "$stub_dir/stellar" <<'STUB'
#!/usr/bin/env bash
contract=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "--id" ]]; then contract="${args[$((i+1))]}"; fi
done
fn="${args[-1]}"
if [[ "$contract" == "contractA" ]]; then
  if [[ "$fn" == "get_credential_count" ]]; then echo "\"10\""; else echo "\"5\""; fi
elif [[ "$contract" == "contractB" ]]; then
  if [[ "$fn" == "get_credential_count" ]]; then echo "\"12\""; else echo "error: timeout" >&2; exit 1; fi
fi
STUB
chmod +x "$stub_dir/stellar"
run_reconcile "contractA" "contractB" "$stub_dir"
exit_code=$?
report="$(latest_report)"
assert_eq "mixed result exits 1 (inconsistency takes priority)" "1" "$exit_code"
assert_eq "mixed result status is inconsistent" "inconsistent" "$(jq -r .status "$report")"
assert_eq "mixed result inconsistencies=1" "1" "$(jq -r .inconsistencies "$report")"
assert_eq "mixed result unverified=1" "1" "$(jq -r .unverified "$report")"
assert_eq "mixed result unverified_metrics contains slice_count" "slice_count" "$(jq -r '.unverified_metrics[0]' "$report")"

# ── Test 6: existing report schema keys are preserved ────────────────────────
reset_stubs
STUB_CRED_A=1 STUB_SLICE_A=1 STUB_CRED_B=1 STUB_SLICE_B=1 \
  run_reconcile "contractA" "contractB" "$(make_stub)"
report="$(latest_report)"
for key in timestamp instance_a instance_b inconsistencies; do
  present="$(jq "has(\"$key\")" "$report")"
  assert_eq "report retains legacy key '$key'" "true" "$present"
done
for key in credential_count slice_count; do
  present_a="$(jq ".instance_a | has(\"$key\")" "$report")"
  assert_eq "instance_a retains legacy key '$key'" "true" "$present_a"
done

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
