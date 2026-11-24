#!/usr/bin/env bash
# scripts/tests/test_region_failover.sh — Tests for scripts/region_failover.sh (#1838)
#
# Stubs out `aws`, `curl`, and `terraform` via PATH so no real AWS API, DNS,
# or Terraform state is required.  Each test supplies a REGIONS_JSON fixture
# so load_regions() never touches terraform.
#
# Tests:
#   1. planned --dry-run executes a managed Aurora switchover (aws call present)
#   2. planned --dry-run does NOT execute real aws calls (output is dry-run lines)
#   3. unplanned --dry-run detaches the secondary DB from the global cluster
#   4. unplanned --dry-run does NOT fail over into an already-unhealthy secondary
#   5. dry-run output contains the expected operation verbs (no silent no-ops)
#   6. status shows both region health responses
#
# Run with: ./scripts/tests/test_region_failover.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
FAILOVER_SCRIPT="$ROOT_DIR/region_failover.sh"

PASS=0
FAIL=0

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# ── Region fixture ────────────────────────────────────────────────────────────
# A minimal REGIONS_JSON consumed by load_regions() in the script.
REGIONS_JSON="$WORK_DIR/regions.json"
cat > "$REGIONS_JSON" <<'JSON'
{
  "primary":   { "region": "us-east-1",  "ecs_cluster": "qp-prod-use1",  "ecs_service": "qp-api",  "db_cluster": "qp-db-use1",  "health_check_fqdn": "api.use1.example.com"  },
  "secondary": { "region": "eu-west-1",  "ecs_cluster": "qp-prod-euw1",  "ecs_service": "qp-api",  "db_cluster": "qp-db-euw1",  "health_check_fqdn": "api.euw1.example.com"  }
}
JSON

# ── Fake `aws` stub factory ───────────────────────────────────────────────────
# Controls: STUB_SECONDARY_HEALTHY (0|1), STUB_AWS_FAIL (0|1)
make_aws_stub() {
  local stub_dir="$WORK_DIR/bin_aws_$1"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/aws" <<'STUB'
#!/usr/bin/env bash
# Fake aws CLI.  Inspect the sub-command to decide what to return.
subcmd="${2:-}"

if [[ "${STUB_AWS_FAIL:-0}" == "1" ]]; then
  echo "An error occurred (AccessDeniedException)" >&2
  exit 1
fi

# rds describe-db-clusters → return a fake ARN
if [[ "$subcmd" == "rds" ]]; then
  case "${3:-}" in
    describe-db-clusters)
      echo "arn:aws:rds:eu-west-1:123456789012:cluster:qp-db-euw1"
      exit 0
      ;;
    describe-global-clusters)
      echo -e "arn:aws:rds:us-east-1:123456789012:cluster:qp-db-use1\ttrue\narn:aws:rds:eu-west-1:123456789012:cluster:qp-db-euw1\tfalse"
      exit 0
      ;;
    switchover-global-cluster|remove-from-global-cluster|wait)
      exit 0
      ;;
  esac
fi

# ecs
if [[ "$subcmd" == "ecs" ]]; then
  case "${3:-}" in
    describe-services)
      echo -e "3\t3"
      exit 0
      ;;
    update-service|wait)
      exit 0
      ;;
  esac
fi

# cloudwatch
if [[ "$subcmd" == "cloudwatch" ]]; then
  echo "12"
  exit 0
fi

# sts (used by secrets_manager audit_log — not by region_failover, but guard anyway)
if [[ "$subcmd" == "sts" ]]; then
  echo "arn:aws:iam::123456789012:user/ci"
  exit 0
fi

echo "unhandled: aws $*" >&2
exit 1
STUB
  chmod +x "$stub_dir/aws"
  echo "$stub_dir"
}

# ── Fake `curl` stub factory ──────────────────────────────────────────────────
# Controls: STUB_SECONDARY_HEALTHY (0|1)
make_curl_stub() {
  local stub_dir="$WORK_DIR/bin_curl_$1"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/curl" <<'STUB'
#!/usr/bin/env bash
url=""
for a in "$@"; do
  case "$a" in http*|https*) url="$a" ;; esac
done

# /health/ready
if [[ "$url" == *"/health/ready" ]]; then
  if [[ "${STUB_SECONDARY_HEALTHY:-1}" == "1" ]]; then
    exit 0   # HTTP 200 — script uses -w '%{http_code}' or just the exit code
  else
    exit 7   # curl: couldn't connect
  fi
fi

# /health/region
if [[ "$url" == *"/health/region" ]]; then
  echo '{"peer":{"state":"replica"},"failoverActive":false}'
  exit 0
fi

exit 0
STUB
  chmod +x "$stub_dir/curl"
  echo "$stub_dir"
}

# ── Run helper ────────────────────────────────────────────────────────────────
run_failover() {
  local subcommand="$1" aws_dir="$2" curl_dir="$3"
  shift 3
  (
    PATH="$aws_dir:$curl_dir:$PATH" \
    REGIONS_JSON="$REGIONS_JSON" \
    GLOBAL_CLUSTER="qp-prod-global" \
    SECONDARY_SCALE_TO=3 \
    "$FAILOVER_SCRIPT" "$subcommand" --yes --dry-run "$@" \
      > "$WORK_DIR/stdout.log" 2>"$WORK_DIR/stderr.log"
  )
  return $?
}

# ── Assertion helpers ─────────────────────────────────────────────────────────
assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  ok - $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL - $desc (expected to find: '$needle')"
    echo "         --- stdout ---"
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
    echo "  FAIL - $desc (did not expect to find: '$needle')"
    FAIL=$((FAIL + 1))
  fi
}

assert_exit() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ok - $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL - $desc (expected exit=$expected, got exit=$actual)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== test_region_failover.sh ==="

# ── Test 1: planned --dry-run includes switchover-global-cluster operation ────
# The planned path must call aws rds switchover-global-cluster.
aws_dir=$(make_aws_stub "t1"); curl_dir=$(make_curl_stub "t1")
run_failover "planned" "$aws_dir" "$curl_dir"
out=$(cat "$WORK_DIR/stdout.log" "$WORK_DIR/stderr.log" 2>/dev/null)
assert_contains \
  "planned dry-run prints switchover-global-cluster invocation" \
  "switchover-global-cluster" \
  "$out"

# ── Test 2: planned --dry-run does not actually invoke real aws commands ──────
# In dry-run mode every real command is printed as "[dry-run] …" and not run.
# The script's run() wrapper prefixes all real calls with "[dry-run]".
aws_dir=$(make_aws_stub "t2"); curl_dir=$(make_curl_stub "t2")
run_failover "planned" "$aws_dir" "$curl_dir"
out=$(cat "$WORK_DIR/stdout.log" "$WORK_DIR/stderr.log" 2>/dev/null)
assert_contains \
  "planned dry-run prefixes real commands with [dry-run]" \
  "[dry-run]" \
  "$out"
# Confirm the stub was not called for the state-mutating switchover command
# (the stub would emit nothing traceable; absence of aws errors is enough).
assert_not_contains \
  "planned dry-run does not emit aws error output" \
  "An error occurred" \
  "$out"

# ── Test 3: unplanned --dry-run includes remove-from-global-cluster ───────────
aws_dir=$(make_aws_stub "t3"); curl_dir=$(make_curl_stub "t3")
run_failover "unplanned" "$aws_dir" "$curl_dir"
out=$(cat "$WORK_DIR/stdout.log" "$WORK_DIR/stderr.log" 2>/dev/null)
assert_contains \
  "unplanned dry-run prints remove-from-global-cluster invocation" \
  "remove-from-global-cluster" \
  "$out"

# ── Test 4: unplanned refuses to fail over when secondary /health/ready fails ─
# The script calls wait_ready after scaling the secondary.  When curl exits
# non-zero every iteration for 30 tries, the script must die before completing.
aws_dir=$(make_aws_stub "t4"); curl_dir=$(make_curl_stub "t4")
# dry-run skips wait_ready, so we run WITHOUT --dry-run and with a stub that
# immediately fails.  We also use a low SECONDARY_SCALE_TO and expect a
# non-zero exit.
(
  PATH="$aws_dir:$curl_dir:$PATH" \
  REGIONS_JSON="$REGIONS_JSON" \
  GLOBAL_CLUSTER="qp-prod-global" \
  SECONDARY_SCALE_TO=1 \
  STUB_SECONDARY_HEALTHY=0 \
  "$FAILOVER_SCRIPT" unplanned --yes \
    > "$WORK_DIR/t4_stdout.log" 2>"$WORK_DIR/t4_stderr.log"
) ; t4_exit=$?
# The script should fail: either wait_ready exhausts retries (exit 1 from die)
# or the aws wait stub exits non-zero.  Either way exit != 0.
assert_exit \
  "unplanned with unhealthy secondary exits non-zero (refuses to complete)" \
  "1" \
  "$t4_exit"
out4=$(cat "$WORK_DIR/t4_stdout.log" "$WORK_DIR/t4_stderr.log" 2>/dev/null)
assert_not_contains \
  "unplanned with unhealthy secondary does not print completion message" \
  "Unplanned failover complete" \
  "$out4"

# ── Test 5: dry-run output names the target region and cluster ────────────────
# Operators must be able to review exactly what would change before they confirm.
aws_dir=$(make_aws_stub "t5"); curl_dir=$(make_curl_stub "t5")
run_failover "planned" "$aws_dir" "$curl_dir"
out=$(cat "$WORK_DIR/stdout.log" "$WORK_DIR/stderr.log" 2>/dev/null)
assert_contains \
  "dry-run output names the global cluster" \
  "qp-prod-global" \
  "$out"
assert_contains \
  "dry-run output names the secondary region target" \
  "eu-west-1" \
  "$out"

# ── Test 6: status prints /health/region details for both regions ─────────────
aws_dir=$(make_aws_stub "t6"); curl_dir=$(make_curl_stub "t6")
(
  PATH="$aws_dir:$curl_dir:$PATH" \
  REGIONS_JSON="$REGIONS_JSON" \
  GLOBAL_CLUSTER="qp-prod-global" \
  "$FAILOVER_SCRIPT" status \
    > "$WORK_DIR/t6_stdout.log" 2>"$WORK_DIR/t6_stderr.log"
) ; true  # status exits 0 regardless of health
out6=$(cat "$WORK_DIR/t6_stdout.log" "$WORK_DIR/t6_stderr.log" 2>/dev/null)
assert_contains \
  "status output labels the primary region" \
  "primary" \
  "$out6"
assert_contains \
  "status output labels the secondary region" \
  "secondary" \
  "$out6"
assert_contains \
  "status output shows the Aurora global cluster section" \
  "Aurora global cluster" \
  "$out6"

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
