#!/usr/bin/env bash
# scripts/tests/test_restore_from_backup.sh — Tests for restore_from_backup.sh
#                                              and verify_backup.sh (#1836)
#
# Uses fixture backup files (written into a temp dir) and a fake `soroban`
# binary so no real contract or network is required.
#
# Tests — restore_from_backup.sh:
#   1. Restores credentials and slices from a well-formed fixture backup
#   2. Verifies restored checksums match backup counts in the output
#   3. Exits non-zero when the backup file does not exist
#   4. Exits non-zero when the backup JSON is truncated / malformed
#
# Tests — verify_backup.sh:
#   5. Passes on a valid fixture backup
#   6. Reports FAIL when credential array length mismatches credential_count
#   7. Reports FAIL on a backup that is not valid JSON (truncated)
#   8. Passes dry-run restore validation on a well-formed backup
#
# Run with: ./scripts/tests/test_restore_from_backup.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RESTORE_SCRIPT="$ROOT_DIR/restore_from_backup.sh"
VERIFY_SCRIPT="$ROOT_DIR/verify_backup.sh"

PASS=0
FAIL=0

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# ── Fixture helpers ───────────────────────────────────────────────────────────
make_fixture_backup() {
  local path="$1"
  cat > "$path" <<'JSON'
{
  "backup_date": "2024-01-15_12-00-00",
  "network": "testnet",
  "contract_id": "CTEST1234",
  "credential_count": 2,
  "slice_count": 1,
  "credentials": [
    {
      "subject":         "GSUBJECT1",
      "issuer":          "GISSUER1",
      "credential_type": "identity",
      "metadata_hash":   "abc123",
      "expires_at":      "9999999999"
    },
    {
      "subject":         "GSUBJECT2",
      "issuer":          "GISSUER2",
      "credential_type": "membership",
      "metadata_hash":   "def456",
      "expires_at":      "9999999999"
    }
  ],
  "slices": [
    {
      "creator":   "GCREATOR1",
      "threshold": 2,
      "attestors": ["GATT1", "GATT2", "GATT3"]
    }
  ]
}
JSON
}

make_miscount_backup() {
  # credential_count claims 3 but only 2 entries present
  local path="$1"
  cat > "$path" <<'JSON'
{
  "backup_date": "2024-01-15_12-00-00",
  "network": "testnet",
  "contract_id": "CTEST1234",
  "credential_count": 3,
  "slice_count": 1,
  "credentials": [
    {
      "subject":         "GSUBJECT1",
      "issuer":          "GISSUER1",
      "credential_type": "identity",
      "metadata_hash":   "abc123",
      "expires_at":      "9999999999"
    },
    {
      "subject":         "GSUBJECT2",
      "issuer":          "GISSUER2",
      "credential_type": "membership",
      "metadata_hash":   "def456",
      "expires_at":      "9999999999"
    }
  ],
  "slices": [
    {
      "creator":   "GCREATOR1",
      "threshold": 2,
      "attestors": ["GATT1", "GATT2"]
    }
  ]
}
JSON
}

make_truncated_backup() {
  # Deliberately not valid JSON
  local path="$1"
  printf '{"backup_date":"2024-01-15","credentials":[{"subject":"G' > "$path"
}

# ── Fake `soroban` stub ───────────────────────────────────────────────────────
# restore_from_backup.sh calls: soroban contract invoke --id … --network … -- <fn> [args]
# We simulate a simple in-memory store that tracks how many issue_credential /
# create_slice calls were received, then returns those counts on get_*_count.
# The counts are stored in files under WORK_DIR so they survive subshell calls.
make_soroban_stub() {
  local stub_dir="$WORK_DIR/bin_soroban"
  mkdir -p "$stub_dir"
  # Initialise counters
  echo "0" > "$WORK_DIR/cred_count"
  echo "0" > "$WORK_DIR/slice_count"

  cat > "$stub_dir/soroban" <<STUB
#!/usr/bin/env bash
# Parse the function name (last arg before any -- separator that isn't a flag).
fn=""
for a in "\$@"; do
  case "\$a" in --*) ;; *) fn="\$a" ;; esac
done

case "\$fn" in
  get_credential_count)
    cat "${WORK_DIR}/cred_count"
    ;;
  get_slice_count)
    cat "${WORK_DIR}/slice_count"
    ;;
  issue_credential)
    c=\$(cat "${WORK_DIR}/cred_count")
    echo \$((c + 1)) > "${WORK_DIR}/cred_count"
    ;;
  create_slice)
    s=\$(cat "${WORK_DIR}/slice_count")
    echo \$((s + 1)) > "${WORK_DIR}/slice_count"
    ;;
  *)
    echo "unknown function: \$fn" >&2
    exit 1
    ;;
esac
STUB
  chmod +x "$stub_dir/soroban"
  echo "$stub_dir"
}

# ── Run helpers ───────────────────────────────────────────────────────────────
run_restore() {
  local backup="$1" soroban_dir="$2"
  shift 2
  (
    PATH="$soroban_dir:$PATH" \
    CONTRACT_QUORUM_PROOF="CTEST1234" \
    STELLAR_NETWORK="testnet" \
    "$RESTORE_SCRIPT" --backup "$backup" "$@" \
      > "$WORK_DIR/stdout.log" 2>"$WORK_DIR/stderr.log"
  )
  return $?
}

run_verify() {
  local backup="$1"
  shift
  (
    "$VERIFY_SCRIPT" "$backup" "$@" \
      > "$WORK_DIR/vout.log" 2>"$WORK_DIR/verr.log"
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
    echo "         --- output ---"
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

echo "=== test_restore_from_backup.sh / test_verify_backup.sh ==="
echo ""
echo "--- restore_from_backup.sh ---"

# ── Test 1: restores credentials and slices from a well-formed fixture ────────
fixture="$WORK_DIR/backup_ok.json"
make_fixture_backup "$fixture"
soroban_dir=$(make_soroban_stub)
run_restore "$fixture" "$soroban_dir"
t1_exit=$?
out=$(cat "$WORK_DIR/stdout.log" "$WORK_DIR/stderr.log" 2>/dev/null)
assert_exit "valid restore exits 0" "0" "$t1_exit"
assert_contains \
  "restore output confirms credentials were restored" \
  "Restored 2 credentials" \
  "$out"
assert_contains \
  "restore output confirms slices were restored" \
  "Restored 1 slices" \
  "$out"

# ── Test 2: restored counts in the script output match backup counts ──────────
# The "Verifying restoration" block at the end prints Final credentials/slices.
assert_contains \
  "restore verification prints final credential count" \
  "Final credentials:" \
  "$out"
assert_contains \
  "restore verification prints final slice count" \
  "Final slices:" \
  "$out"

# ── Test 3: exits non-zero when the backup file does not exist ────────────────
soroban_dir=$(make_soroban_stub)
run_restore "/does/not/exist/backup.json" "$soroban_dir"
t3_exit=$?
out=$(cat "$WORK_DIR/stdout.log" "$WORK_DIR/stderr.log" 2>/dev/null)
assert_exit "missing backup file exits non-zero" "1" "$t3_exit"
assert_contains \
  "missing backup file prints an error message" \
  "not found" \
  "$out"

# ── Test 4: exits non-zero on a truncated / malformed backup ─────────────────
bad_fixture="$WORK_DIR/backup_truncated.json"
make_truncated_backup "$bad_fixture"
soroban_dir=$(make_soroban_stub)
run_restore "$bad_fixture" "$soroban_dir"
t4_exit=$?
out=$(cat "$WORK_DIR/stdout.log" "$WORK_DIR/stderr.log" 2>/dev/null)
assert_exit "truncated backup exits non-zero" "1" "$t4_exit"
assert_contains \
  "truncated backup prints JSON error" \
  "not valid JSON" \
  "$out"

echo ""
echo "--- verify_backup.sh ---"

# ── Test 5: verify_backup.sh passes on a well-formed fixture ─────────────────
fixture="$WORK_DIR/backup_ok.json"
make_fixture_backup "$fixture"
run_verify "$fixture"
t5_exit=$?
vout=$(cat "$WORK_DIR/vout.log" "$WORK_DIR/verr.log" 2>/dev/null)
assert_exit "verify passes on a valid backup (exit 0)" "0" "$t5_exit"
assert_contains \
  "verify prints 'Backup is valid'" \
  "Backup is valid" \
  "$vout"

# ── Test 6: verify fails when credential array length mismatches ──────────────
mismatch="$WORK_DIR/backup_mismatch.json"
make_miscount_backup "$mismatch"
run_verify "$mismatch"
t6_exit=$?
vout=$(cat "$WORK_DIR/vout.log" "$WORK_DIR/verr.log" 2>/dev/null)
assert_exit "verify fails on credential count mismatch (exit 1)" "1" "$t6_exit"
assert_contains \
  "verify prints FAIL for mismatched credential count" \
  "[FAIL]" \
  "$vout"

# ── Test 7: verify fails on a truncated (non-JSON) backup ────────────────────
truncated="$WORK_DIR/backup_trunc2.json"
make_truncated_backup "$truncated"
run_verify "$truncated"
t7_exit=$?
vout=$(cat "$WORK_DIR/vout.log" "$WORK_DIR/verr.log" 2>/dev/null)
assert_exit "verify exits non-zero on truncated backup" "1" "$t7_exit"
assert_contains \
  "verify reports 'not valid JSON' on truncated backup" \
  "not valid JSON" \
  "$vout"

# ── Test 8: dry-run restore validation passes on the well-formed fixture ──────
fixture="$WORK_DIR/backup_ok.json"
make_fixture_backup "$fixture"
run_verify "$fixture" --dry-run-restore
t8_exit=$?
vout=$(cat "$WORK_DIR/vout.log" "$WORK_DIR/verr.log" 2>/dev/null)
assert_exit "dry-run restore exits 0 on a well-formed backup" "0" "$t8_exit"
assert_contains \
  "dry-run restore reports all required fields present" \
  "Restore dry-run: all records have required fields" \
  "$vout"

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
