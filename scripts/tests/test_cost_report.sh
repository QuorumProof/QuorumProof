#!/usr/bin/env bash
# scripts/tests/test_cost_report.sh — Tests for scripts/cost_report.sh
#
# Exercises cost_report.sh against a fake `curl` binary that serves fixture
# JSON responses, so no real API server is required. Each test selects the
# fixture files the fake should return and asserts on the rendered report,
# the optional JSON output, and error handling.
#
# Run with: ./scripts/tests/test_cost_report.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
COST_REPORT_SCRIPT="$ROOT_DIR/cost_report.sh"

PASS=0
FAIL=0

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# ── Fixtures ──────────────────────────────────────────────────────────────────
REPORT_FIXTURE="$WORK_DIR/report.json"
OPTS_FIXTURE="$WORK_DIR/optimizations.json"
PROJECTION_FIXTURE="$WORK_DIR/projection.json"

cat > "$REPORT_FIXTURE" <<'JSON'
{
  "totalCalls": 150,
  "totalStroops": 4500,
  "totalXlm": "0.045",
  "totalUsd": "0.0054",
  "operations": [
    {"name": "issue_credential", "calls": 100, "totalStroops": 3000, "avgStroops": 30},
    {"name": "verify_claim", "calls": 40, "totalStroops": 1200, "avgStroops": 30},
    {"name": "revoke_credential", "calls": 10, "totalStroops": 300, "avgStroops": 30}
  ]
}
JSON

cat > "$OPTS_FIXTURE" <<'JSON'
{
  "candidates": [
    {
      "operation": "issue_credential",
      "recommendation": "Batch attestations",
      "estimatedSavingsXlm": 1.5
    }
  ]
}
JSON

cat > "$PROJECTION_FIXTURE" <<'JSON'
{"projectedXlm": "12.5", "projectedUsd": "1.50"}
JSON

# ── Fake `curl` ───────────────────────────────────────────────────────────────
# Serves the fixture selected by STUB_REPORT / STUB_OPTS / STUB_PROJECTION.
# STUB_FAIL_REPORT=1 makes the report endpoint fail; STUB_LOG records URLs.
make_curl_stub() {
  local stub_dir="$WORK_DIR/bin"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/curl" <<'STUB'
#!/usr/bin/env bash
url=""
for a in "$@"; do
  case "$a" in http*) url="$a" ;; esac
done

[[ -n "${STUB_LOG:-}" ]] && printf '%s\n' "$url" >> "$STUB_LOG"

if [[ "$url" == */api/costs/report* ]]; then
  [[ "${STUB_FAIL_REPORT:-0}" == "1" ]] && exit 22
  cat "$STUB_REPORT"
elif [[ "$url" == */api/costs/optimizations* ]]; then
  cat "$STUB_OPTS"
elif [[ "$url" == */api/costs/projection* ]]; then
  [[ -n "${STUB_PROJECTION:-}" ]] && cat "$STUB_PROJECTION"
else
  exit 1
fi
STUB
  chmod +x "$stub_dir/curl"
  echo "$stub_dir"
}

run_cost_report() {
  local stub_dir="$1"
  shift
  (
    cd "$WORK_DIR" && \
    PATH="$stub_dir:$PATH" \
    STUB_REPORT="$REPORT_FIXTURE" \
    STUB_OPTS="$OPTS_FIXTURE" \
    STUB_PROJECTION="$PROJECTION_FIXTURE" \
    API_BASE_URL="http://fixture.test" \
    "$COST_REPORT_SCRIPT" "$@" > "$WORK_DIR/stdout.log" 2>"$WORK_DIR/stderr.log"
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

STUB_DIR="$(make_curl_stub)"

echo "=== test_cost_report.sh ==="

# ── Test 1: summary renders totals, per-operation breakdown, optimization
# candidates, and projections from fixture data ──────────────────────────────
run_cost_report "$STUB_DIR"
status=$?
out=$(cat "$WORK_DIR/stdout.log")
err=$(cat "$WORK_DIR/stderr.log")
assert_status "report exits successfully" 0 "$status"
assert_contains "summary header rendered" "QuorumProof Cost Report" "$out"
assert_contains "total API calls rendered" "150" "$out"
assert_contains "total stroops rendered with unit" "4500 stroops" "$out"
assert_contains "total XLM rendered with unit" "0.045 XLM" "$out"
assert_contains "total USD rendered with unit" "0.0054 USD" "$out"
assert_contains "first operation rendered" "issue_credential" "$out"
assert_contains "second operation rendered" "verify_claim" "$out"
assert_contains "operation percentage computed (3000/4500)" "66%" "$out"
assert_contains "operation percentage computed (1200/4500)" "26%" "$out"
assert_contains "optimization candidate rendered" "Batch attestations" "$out"
assert_contains "optimization savings rendered" "1.5 XLM/day" "$out"
assert_contains "projection header uses defaults" "10000 calls/day × 30 days" "$out"
assert_contains "projected XLM rendered" "12.5 XLM" "$out"
assert_contains "projected USD rendered" "1.50 USD" "$out"
assert_not_contains "no report errors on success" "ERROR:" "$err"

# ── Test 2: --json emits the combined report to stdout ──────────────────────
run_cost_report "$STUB_DIR" --json
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "--json exits successfully" 0 "$status"
assert_contains "--json emits timestamp" '"timestamp"' "$out"
assert_contains "--json emits report object" '"report"' "$out"
assert_contains "--json emits optimizations object" '"optimizations"' "$out"
assert_contains "--json includes fixture total calls" '"totalCalls": 150' "$out"

# ── Test 3: --output writes a valid combined JSON report ────────────────────
COMBINED_FILE="$WORK_DIR/combined.json"
run_cost_report "$STUB_DIR" --output "$COMBINED_FILE"
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "--output exits successfully" 0 "$status"
assert_contains "--output logs destination" "Full JSON report written to: $COMBINED_FILE" "$out"
if [[ -f "$COMBINED_FILE" ]] && jq -e '
    .report.totalCalls == 150 and
    .report.totalStroops == 4500 and
    .optimizations.candidates[0].operation == "issue_credential" and
    (.timestamp | type == "string")
  ' "$COMBINED_FILE" >/dev/null 2>&1; then
  echo "  ok - combined JSON report is valid and contains fixture data"
  PASS=$((PASS + 1))
else
  echo "  FAIL - combined JSON report missing or malformed"
  FAIL=$((FAIL + 1))
fi

# ── Test 4: --top limits the breakdown and --days/--calls feed projections ──
export STUB_LOG="$WORK_DIR/urls.log"
PROJECTION_FIXTURE="" run_cost_report "$STUB_DIR" --top 1 --days 7 --calls 500
status=$?
out=$(cat "$WORK_DIR/stdout.log")
assert_status "--top/--days/--calls exit successfully" 0 "$status"
assert_contains "--top keeps the first operation" "issue_credential" "$out"
assert_not_contains "--top drops later operations" "verify_claim" "$out"
assert_not_contains "--top drops later operations (revoke)" "revoke_credential" "$out"
assert_contains "projection header honours --days/--calls" "500 calls/day × 7 days" "$out"
assert_contains "optimization request forwards --top" "optimizations?top=1" "$(cat "$STUB_LOG")"
unset STUB_LOG

# ── Test 5: unreachable report endpoint fails loudly ────────────────────────
STUB_FAIL_REPORT=1 run_cost_report "$STUB_DIR"
status=$?
err=$(cat "$WORK_DIR/stderr.log")
assert_status "unreachable API exits non-zero" 1 "$status"
assert_contains "unreachable API reports the failed endpoint" \
  "ERROR: Could not reach http://fixture.test/api/costs/report" "$err"

# ── Test 6: unknown options are rejected ────────────────────────────────────
run_cost_report "$STUB_DIR" --bogus
status=$?
err=$(cat "$WORK_DIR/stderr.log")
assert_status "unknown option exits non-zero" 1 "$status"
assert_contains "unknown option is named" "Unknown option: --bogus" "$err"

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
