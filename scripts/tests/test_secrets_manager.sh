#!/usr/bin/env bash
# scripts/tests/test_secrets_manager.sh — Tests for scripts/secrets_manager.sh (#1835)
#
# Stubs out `aws`, `vault`, and `jq` (the latter is real; it is verified to be
# present).  Each test configures stub behaviour via env vars, runs the real
# script as a subprocess, and asserts on stdout/stderr/audit-log and exit code.
#
# Tests:
#   1. get retrieves a secret and writes an audit-log entry
#   2. get exits non-zero when the secret does not exist
#   3. set writes an audit-log entry and does not echo the secret value to stdout
#   4. rotate writes an audit-log entry
#   5. list outputs secret names and writes an audit-log entry
#   6. audit prints the log in tabular form
#   7. check passes when all required secrets are present
#   8. check fails and exits non-zero when a required secret is missing
#   9. Secret values never appear in the audit log
#  10. rotate failure rolls back (audit-log records status=error) and exits non-zero
#
# Run with: ./scripts/tests/test_secrets_manager.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SECRETS_SCRIPT="$ROOT_DIR/secrets_manager.sh"

PASS=0
FAIL=0

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# ── Fake `aws` stub factory ───────────────────────────────────────────────────
# Controls:
#   STUB_SECRET_VALUE   — the value returned by get-secret-value
#   STUB_SECRET_EXISTS  (0|1) — whether describe-secret succeeds
#   STUB_ROTATE_FAIL    (0|1) — whether rotate-secret should fail
#   STUB_LIST_NAMES     — newline-separated secret names for list-secrets
make_aws_stub() {
  local stub_dir="$WORK_DIR/bin_aws_$1"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/aws" <<'STUB'
#!/usr/bin/env bash
service="${1:-}"
subcommand="${2:-}"

# sts get-caller-identity (used by audit_log)
if [[ "$service" == "sts" ]]; then
  echo "arn:aws:iam::123456789012:user/ci-test"
  exit 0
fi

if [[ "$service" != "secretsmanager" ]]; then
  echo "unhandled aws service: $service" >&2
  exit 1
fi

case "$subcommand" in
  get-secret-value)
    if [[ "${STUB_SECRET_EXISTS:-1}" == "1" ]]; then
      echo "${STUB_SECRET_VALUE:-super-secret-value}"
      exit 0
    else
      echo "ResourceNotFoundException" >&2
      exit 1
    fi
    ;;
  describe-secret)
    [[ "${STUB_SECRET_EXISTS:-1}" == "1" ]] && exit 0 || exit 1
    ;;
  put-secret-value|create-secret)
    exit 0
    ;;
  rotate-secret)
    if [[ "${STUB_ROTATE_FAIL:-0}" == "1" ]]; then
      echo "InternalServiceError: rotation lambda failed" >&2
      exit 1
    fi
    exit 0
    ;;
  list-secrets)
    if [[ -n "${STUB_LIST_NAMES:-}" ]]; then
      echo "${STUB_LIST_NAMES}"
    fi
    exit 0
    ;;
  *)
    echo "unhandled secretsmanager subcommand: $subcommand" >&2
    exit 1
    ;;
esac
STUB
  chmod +x "$stub_dir/aws"
  echo "$stub_dir"
}

# ── Run helper ────────────────────────────────────────────────────────────────
# Sets a unique AUDIT_LOG_FILE per test so entries don't bleed across tests.
run_secrets() {
  local test_id="$1" aws_dir="$2"
  shift 2
  local audit_log="$WORK_DIR/audit_${test_id}.log"
  (
    PATH="$aws_dir:$PATH" \
    ENVIRONMENT="staging" \
    AWS_REGION="us-east-1" \
    AUDIT_LOG_FILE="$audit_log" \
    VAULT_ADDR="" \
    VAULT_TOKEN="" \
    "$SECRETS_SCRIPT" "$@" \
      > "$WORK_DIR/stdout_${test_id}.log" \
      2>"$WORK_DIR/stderr_${test_id}.log"
  )
  return $?
}

get_stdout() { cat "$WORK_DIR/stdout_${1}.log" 2>/dev/null; }
get_stderr() { cat "$WORK_DIR/stderr_${1}.log" 2>/dev/null; }
get_audit()  { cat "$WORK_DIR/audit_${1}.log"  2>/dev/null; }

# ── Assertion helpers ─────────────────────────────────────────────────────────
assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  ok - $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL - $desc (expected to find: '$needle')"
    echo "         --- content ---"
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
    echo "         --- content ---"
    while IFS= read -r line; do echo "         $line"; done <<<"$haystack"
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

echo "=== test_secrets_manager.sh ==="

# ── Test 1: get retrieves a secret and writes an audit-log entry ─────────────
aws_dir=$(make_aws_stub "t1")
STUB_SECRET_VALUE="my-jwt-secret" STUB_SECRET_EXISTS=1 \
  run_secrets "t1" "$aws_dir" get "quorumproof/staging/api-server/jwt-secret"
t1_exit=$?
assert_exit "get exits 0 when secret exists" "0" "$t1_exit"
assert_contains \
  "get prints the secret value to stdout" \
  "my-jwt-secret" \
  "$(get_stdout t1)"
assert_contains \
  "get writes an audit-log entry with action=get" \
  '"action":"get"' \
  "$(get_audit t1)"

# ── Test 2: get exits non-zero when secret does not exist ─────────────────────
aws_dir=$(make_aws_stub "t2")
STUB_SECRET_EXISTS=0 \
  run_secrets "t2" "$aws_dir" get "quorumproof/staging/api-server/jwt-secret"
t2_exit=$?
assert_exit "get exits non-zero for a missing secret" "1" "$t2_exit"
assert_contains \
  "get writes an audit-log entry with status=not-found" \
  '"status":"not-found"' \
  "$(get_audit t2)"

# ── Test 3: set writes an audit entry and does not echo the value to stdout ───
aws_dir=$(make_aws_stub "t3")
STUB_SECRET_EXISTS=1 \
  run_secrets "t3" "$aws_dir" set \
    "quorumproof/staging/api-server/jwt-secret" \
    "TOP_SECRET_VALUE_XYZ"
t3_exit=$?
assert_exit "set exits 0" "0" "$t3_exit"
assert_contains \
  "set writes an audit-log entry with action=set" \
  '"action":"set"' \
  "$(get_audit t3)"
assert_not_contains \
  "set does not print the secret value to stdout" \
  "TOP_SECRET_VALUE_XYZ" \
  "$(get_stdout t3)"

# ── Test 4: rotate writes an audit-log entry ──────────────────────────────────
aws_dir=$(make_aws_stub "t4")
STUB_ROTATE_FAIL=0 \
  run_secrets "t4" "$aws_dir" rotate \
    "quorumproof/staging/stellar/deploy-key"
t4_exit=$?
assert_exit "rotate exits 0 on success" "0" "$t4_exit"
assert_contains \
  "rotate writes an audit-log entry with action=rotate" \
  '"action":"rotate"' \
  "$(get_audit t4)"
assert_contains \
  "rotate audit-log entry has status=ok" \
  '"status":"ok"' \
  "$(get_audit t4)"

# ── Test 5: list outputs secret names ─────────────────────────────────────────
aws_dir=$(make_aws_stub "t5")
STUB_LIST_NAMES="quorumproof/staging/stellar/deploy-key
quorumproof/staging/database/url" \
  run_secrets "t5" "$aws_dir" list "quorumproof/staging"
t5_exit=$?
assert_exit "list exits 0" "0" "$t5_exit"
assert_contains \
  "list output includes first secret name" \
  "quorumproof/staging/stellar/deploy-key" \
  "$(get_stdout t5)"
assert_contains \
  "list output includes second secret name" \
  "quorumproof/staging/database/url" \
  "$(get_stdout t5)"

# ── Test 6: audit prints the log in tabular form ──────────────────────────────
# Seed the audit log by running a get, then run audit.
aws_dir=$(make_aws_stub "t6")
STUB_SECRET_VALUE="val" STUB_SECRET_EXISTS=1 \
  run_secrets "t6" "$aws_dir" get "quorumproof/staging/api-server/jwt-secret"
# Now run audit against the same log file
audit_log="$WORK_DIR/audit_t6.log"
(
  PATH="$aws_dir:$PATH" \
  ENVIRONMENT="staging" \
  AWS_REGION="us-east-1" \
  AUDIT_LOG_FILE="$audit_log" \
  VAULT_ADDR="" \
  VAULT_TOKEN="" \
  "$SECRETS_SCRIPT" audit \
    > "$WORK_DIR/stdout_t6_audit.log" \
    2>"$WORK_DIR/stderr_t6_audit.log"
)
audit_out=$(cat "$WORK_DIR/stdout_t6_audit.log" "$WORK_DIR/stderr_t6_audit.log" 2>/dev/null)
assert_contains \
  "audit output includes the action field" \
  "get" \
  "$audit_out"

# ── Test 7: check passes when all required secrets are present ────────────────
aws_dir=$(make_aws_stub "t7")
STUB_SECRET_EXISTS=1 \
  run_secrets "t7" "$aws_dir" check
t7_exit=$?
assert_exit "check exits 0 when all secrets are present" "0" "$t7_exit"
assert_contains \
  "check prints 'All required secrets present'" \
  "All required secrets present" \
  "$(get_stderr t7)"

# ── Test 8: check fails when a required secret is missing ─────────────────────
aws_dir=$(make_aws_stub "t8")
STUB_SECRET_EXISTS=0 \
  run_secrets "t8" "$aws_dir" check
t8_exit=$?
assert_exit "check exits non-zero when secrets are missing" "1" "$t8_exit"
assert_contains \
  "check output names missing secrets" \
  "MISSING" \
  "$(get_stderr t8)"

# ── Test 9: secret values never appear in the audit log ───────────────────────
# This is the key security property.  Run set with a known sentinel value,
# then confirm the sentinel is absent from the audit log.
aws_dir=$(make_aws_stub "t9")
STUB_SECRET_EXISTS=1 \
  run_secrets "t9" "$aws_dir" set \
    "quorumproof/staging/api-server/webhook-signing-key" \
    "SENTINEL_SECRET_DO_NOT_LOG"
audit_content=$(get_audit t9)
assert_not_contains \
  "audit log does not contain the secret value" \
  "SENTINEL_SECRET_DO_NOT_LOG" \
  "$audit_content"
# Also check stderr (the [HH:MM:SSZ] log() lines printed to stderr)
assert_not_contains \
  "stderr log does not contain the secret value" \
  "SENTINEL_SECRET_DO_NOT_LOG" \
  "$(get_stderr t9)"

# ── Test 10: rotate failure records status=error in audit log and exits non-zero
aws_dir=$(make_aws_stub "t10")
STUB_ROTATE_FAIL=1 \
  run_secrets "t10" "$aws_dir" rotate \
    "quorumproof/staging/stellar/deploy-key"
t10_exit=$?
assert_exit "rotate failure exits non-zero" "1" "$t10_exit"
assert_contains \
  "rotate failure writes audit-log entry with status=error" \
  '"status":"error"' \
  "$(get_audit t10)"
assert_not_contains \
  "rotate failure audit entry does not falsely claim status=ok" \
  '"status":"ok"' \
  "$(get_audit t10)"

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
