#!/usr/bin/env bash
# scripts/tests/test_log_archive_retrieve.sh — Tests for scripts/log_archive.sh and scripts/log_retrieve.sh
#
# Addresses #1840:
# - Test archive and retrieval round-trip with a fixture log set
# - Test that archived logs keep their checksums
# - Test retrieval when the archive key/date range is missing
# - Test checksum mismatch failure on corrupted archive
# - Test grep filtering and host-specific retrieval
#
# Run with: ./scripts/tests/test_log_archive_retrieve.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ARCHIVE_SCRIPT="$ROOT_DIR/log_archive.sh"
RETRIEVE_SCRIPT="$ROOT_DIR/log_retrieve.sh"

PASS=0
FAIL=0

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

pass() {
  PASS=$((PASS + 1))
  printf "  \033[32m✔\033[0m %s\n" "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf "  \033[31m✘\033[0m %s: %s\n" "$1" "$2"
}

echo "=== Running log_archive & log_retrieve test suite ==="

# ── Test 1: Round-trip archival and retrieval with fixture logs ─────────────
echo "Test 1: Round-trip archival and retrieval with fixture logs"
T1_LOG_DIR="$WORK_DIR/t1_logs"
T1_ARCHIVE_DIR="$WORK_DIR/t1_archive"
T1_RESTORE_DIR="$WORK_DIR/t1_restored"
mkdir -p "$T1_LOG_DIR" "$T1_ARCHIVE_DIR" "$T1_RESTORE_DIR"

# Create fixture logs formatted as <name>-YYYYMMDDTHHMMSSZ.log.gz
echo '{"level":"info","msg":"service started","timestamp":"2026-10-23T10:00:00Z"}' > "$T1_LOG_DIR/api.raw"
echo '{"level":"error","msg":"connection refused","timestamp":"2026-10-23T10:05:00Z"}' >> "$T1_LOG_DIR/api.raw"
gzip -c "$T1_LOG_DIR/api.raw" > "$T1_LOG_DIR/api-20261023T100000Z.log.gz"

echo '{"level":"info","msg":"audit event 101","timestamp":"2026-10-23T10:10:00Z"}' > "$T1_LOG_DIR/audit.raw"
gzip -c "$T1_LOG_DIR/audit.raw" > "$T1_LOG_DIR/audit-20261023T101000Z.log.gz"

# Run archive script
LOG_DIR="$T1_LOG_DIR" \
LOG_ARCHIVE_DIR="$T1_ARCHIVE_DIR" \
HOST_ID="test-host-1" \
LOG_ARCHIVE_BUCKET="" \
"$ARCHIVE_SCRIPT" --once >/dev/null 2>&1

if [[ -f "$T1_ARCHIVE_DIR/test-host-1/2026/10/23/api-20261023T100000Z.log.gz" && \
      -f "$T1_ARCHIVE_DIR/test-host-1/2026/10/23/audit-20261023T101000Z.log.gz" ]]; then
  pass "Archived files placed in expected host and date partitioned directory"
else
  fail "Archive placement" "Expected archived files in $T1_ARCHIVE_DIR/test-host-1/2026/10/23/"
fi

# Run retrieve script
LOG_ARCHIVE_DIR="$T1_ARCHIVE_DIR" \
LOG_ARCHIVE_BUCKET="" \
"$RETRIEVE_SCRIPT" --from 2026-10-23 --to 2026-10-23 \
  --output "$T1_RESTORE_DIR" \
  --reason "compliance audit check" >/dev/null 2>&1
ret_exit=$?

if [[ "$ret_exit" -eq 0 ]]; then
  pass "Retrieve script exited with code 0"
else
  fail "Retrieve exit status" "Expected 0, got $ret_exit"
fi

# Verify restored file content integrity
if [[ -f "$T1_RESTORE_DIR/test-host-1/2026/10/23/api-20261023T100000Z.log.gz" ]]; then
  restored_content=$(zcat "$T1_RESTORE_DIR/test-host-1/2026/10/23/api-20261023T100000Z.log.gz")
  expected_content=$(cat "$T1_LOG_DIR/api.raw")
  if [[ "$restored_content" == "$expected_content" ]]; then
    pass "Restored log content matches original fixture"
  else
    fail "Restored log content" "Content mismatch between fixture and restored log"
  fi
else
  fail "Restored file existence" "File not found in restored output"
fi

# Verify audit trail
if [[ -f "$T1_RESTORE_DIR/retrievals.log" ]] && grep -q "compliance audit check" "$T1_RESTORE_DIR/retrievals.log"; then
  pass "Retrieval audit trail recorded reason and metadata"
else
  fail "Audit trail" "retrievals.log missing or did not record audit reason"
fi

# ── Test 2: Checksum integrity and detection of corrupted archive ───────────
echo "Test 2: Checksum verification and tamper detection"
T2_LOG_DIR="$WORK_DIR/t2_logs"
T2_ARCHIVE_DIR="$WORK_DIR/t2_archive"
T2_RESTORE_DIR="$WORK_DIR/t2_restored"
mkdir -p "$T2_LOG_DIR" "$T2_ARCHIVE_DIR" "$T2_RESTORE_DIR"

echo '{"level":"info","msg":"critical transaction ledger"}' | gzip -c > "$T2_LOG_DIR/ledger-20261023T110000Z.log.gz"

LOG_DIR="$T2_LOG_DIR" \
LOG_ARCHIVE_DIR="$T2_ARCHIVE_DIR" \
HOST_ID="test-host-1" \
LOG_ARCHIVE_BUCKET="" \
"$ARCHIVE_SCRIPT" --once >/dev/null 2>&1

# Verify SHA256SUMS file exists
if [[ -f "$T2_ARCHIVE_DIR/test-host-1/2026/10/23/SHA256SUMS" ]]; then
  pass "SHA256SUMS manifest created alongside archived logs"
else
  fail "SHA256SUMS creation" "SHA256SUMS not found in archive directory"
fi

# Tamper with the archived log to simulate storage bit-rot/corruption
archived_file="$T2_ARCHIVE_DIR/test-host-1/2026/10/23/ledger-20261023T110000Z.log.gz"
echo "corrupted payload" >> "$archived_file"

# Retrieve should fail with checksum mismatch exit code 1
set +e
LOG_ARCHIVE_DIR="$T2_ARCHIVE_DIR" \
LOG_ARCHIVE_BUCKET="" \
"$RETRIEVE_SCRIPT" --from 2026-10-23 --to 2026-10-23 \
  --output "$T2_RESTORE_DIR" \
  --reason "integrity check" >/dev/null 2>&1
tamper_exit=$?
set -e

if [[ "$tamper_exit" -eq 1 ]]; then
  pass "Retrieve correctly aborted with exit code 1 on checksum mismatch"
else
  fail "Tamper detection" "Expected exit code 1 on corrupted archive, got $tamper_exit"
fi

# ── Test 3: Retrieval when key/date range is missing ─────────────────────────
echo "Test 3: Missing date range handling"
T3_RESTORE_DIR="$WORK_DIR/t3_restored"
mkdir -p "$T3_RESTORE_DIR"

# Query a date range where no archives exist (2025-01-01 to 2025-01-02)
LOG_ARCHIVE_DIR="$T1_ARCHIVE_DIR" \
LOG_ARCHIVE_BUCKET="" \
"$RETRIEVE_SCRIPT" --from 2025-01-01 --to 2025-01-02 \
  --output "$T3_RESTORE_DIR" \
  --reason "query nonexistent date range" > "$WORK_DIR/t3.out" 2>&1
missing_exit=$?

if [[ "$missing_exit" -eq 0 ]]; then
  pass "Retrieve handles nonexistent date range gracefully with exit code 0"
else
  fail "Missing range exit" "Expected 0, got $missing_exit"
fi

if grep -q "downloaded: 0" "$WORK_DIR/t3.out"; then
  pass "Retrieve reports 0 objects downloaded for missing range"
else
  fail "Missing range output" "Expected 'downloaded: 0' in output"
fi

# ── Test 4: Grep filtering on restored logs ──────────────────────────────────
echo "Test 4: Grep regex pattern filtering"
T4_RESTORE_DIR="$WORK_DIR/t4_restored"
mkdir -p "$T4_RESTORE_DIR"

LOG_ARCHIVE_DIR="$T1_ARCHIVE_DIR" \
LOG_ARCHIVE_BUCKET="" \
"$RETRIEVE_SCRIPT" --from 2026-10-23 --to 2026-10-23 \
  --output "$T4_RESTORE_DIR" \
  --reason "filter error lines" \
  --grep "connection refused" >/dev/null 2>&1

if [[ -f "$T4_RESTORE_DIR/matches.jsonl" ]] && grep -q "connection refused" "$T4_RESTORE_DIR/matches.jsonl"; then
  pass "Grep output matches.jsonl captured target error line"
else
  fail "Grep filter" "matches.jsonl missing or missing expected matching line"
fi

# ── Test 5: Host-specific filtering ──────────────────────────────────────────
echo "Test 5: Host filtering"
T5_LOG_DIR="$WORK_DIR/t5_logs"
T5_ARCHIVE_DIR="$WORK_DIR/t5_archive"
T5_RESTORE_DIR="$WORK_DIR/t5_restored"
mkdir -p "$T5_LOG_DIR" "$T5_ARCHIVE_DIR" "$T5_RESTORE_DIR"

echo 'node-a log data' | gzip -c > "$T5_LOG_DIR/nodea-20261023T120000Z.log.gz"
LOG_DIR="$T5_LOG_DIR" LOG_ARCHIVE_DIR="$T5_ARCHIVE_DIR" HOST_ID="node-a" LOG_ARCHIVE_BUCKET="" "$ARCHIVE_SCRIPT" --once >/dev/null 2>&1
rm -f "$T5_LOG_DIR"/*

echo 'node-b log data' | gzip -c > "$T5_LOG_DIR/nodeb-20261023T120000Z.log.gz"
LOG_DIR="$T5_LOG_DIR" LOG_ARCHIVE_DIR="$T5_ARCHIVE_DIR" HOST_ID="node-b" LOG_ARCHIVE_BUCKET="" "$ARCHIVE_SCRIPT" --once >/dev/null 2>&1

# Retrieve only for host node-a
LOG_ARCHIVE_DIR="$T5_ARCHIVE_DIR" LOG_ARCHIVE_BUCKET="" \
"$RETRIEVE_SCRIPT" --from 2026-10-23 --to 2026-10-23 --host "node-a" \
  --output "$T5_RESTORE_DIR" --reason "host specific filter" >/dev/null 2>&1

if [[ -d "$T5_RESTORE_DIR/node-a" && ! -d "$T5_RESTORE_DIR/node-b" ]]; then
  pass "Host filtering correctly restricted retrieval to specified host"
else
  fail "Host filter" "Expected only node-a to be retrieved"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo "====================================================="
echo "Test results: $PASS passed, $FAIL failed"
echo "====================================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
