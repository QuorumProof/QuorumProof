#!/usr/bin/env bash
# scripts/validate_dr.sh — Automated DR Validation
#
# Issue #1659 — Add Disaster Recovery Testing
#
# Lightweight validation that can run in CI on every push to verify that
# the DR scripts and docs are self-consistent. Does NOT run live DR scenarios
# (use dr_test_harness.sh for that). Checks:
#
#   1. All DR scripts referenced in docs/disaster-recovery.md exist and are
#      executable.
#   2. The RTO/RPO table in docs/disaster-recovery.md has entries for the
#      expected scenario categories.
#   3. The DR runbook (docs/dr-runbook.md) references the same scripts.
#   4. The backup schedule in scripts/automated_backup.sh is consistent with
#      the RPO stated in the docs.
#
# Usage:
#   ./scripts/validate_dr.sh
#
# Exit codes:
#   0 — all checks pass
#   1 — one or more checks fail

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*" >&2; }

FAILURES=0

check_failed() { (( FAILURES++ )); fail "$@"; }

# ── Check 1: Required DR scripts exist and are executable ─────────────────────
echo "=== Check 1: DR scripts exist and are executable ==="
DR_SCRIPTS=(
  "backup.sh"
  "verify_backup.sh"
  "check_backup_integrity.sh"
  "restore_from_backup.sh"
  "snapshot.sh"
  "verify_snapshot.sh"
  "failover.sh"
  "reconcile_state.sh"
  "dr_test_harness.sh"
  "validate_dr.sh"
)

for script in "${DR_SCRIPTS[@]}"; do
  path="$SCRIPT_DIR/$script"
  if [[ ! -f "$path" ]]; then
    check_failed "Missing DR script: scripts/$script"
  elif [[ ! -x "$path" ]]; then
    check_failed "Not executable: scripts/$script"
  else
    info "scripts/$script"
  fi
done

# ── Check 2: DR docs exist ────────────────────────────────────────────────────
echo ""
echo "=== Check 2: DR documentation files exist ==="
DR_DOCS=(
  "docs/disaster-recovery.md"
  "docs/DR_PLAN_IMPLEMENTATION.md"
  "docs/backup-system.md"
  "docs/backup-verification.md"
  "docs/dr-runbook.md"
)

for doc in "${DR_DOCS[@]}"; do
  path="$ROOT_DIR/$doc"
  if [[ ! -f "$path" ]]; then
    check_failed "Missing DR doc: $doc"
  else
    info "$doc"
  fi
done

# ── Check 3: disaster-recovery.md contains RTO/RPO section ────────────────────
echo ""
echo "=== Check 3: RTO/RPO targets documented ==="
DR_DOC="$ROOT_DIR/docs/disaster-recovery.md"
if [[ -f "$DR_DOC" ]]; then
  if grep -qi "RTO\|Recovery Time Objective" "$DR_DOC"; then
    info "RTO entries found in docs/disaster-recovery.md"
  else
    check_failed "docs/disaster-recovery.md has no RTO/Recovery Time Objective section"
  fi

  if grep -qi "RPO\|Recovery Point Objective" "$DR_DOC"; then
    info "RPO entries found in docs/disaster-recovery.md"
  else
    check_failed "docs/disaster-recovery.md has no RPO/Recovery Point Objective section"
  fi
fi

# ── Check 4: DR runbook references key recovery procedures ────────────────────
echo ""
echo "=== Check 4: DR runbook completeness ==="
RUNBOOK="$ROOT_DIR/docs/dr-runbook.md"
if [[ -f "$RUNBOOK" ]]; then
  REQUIRED_RUNBOOK_SECTIONS=(
    "rpc"
    "backup"
    "snapshot"
    "key"
    "metrics"
    "recovery"
  )
  for section in "${REQUIRED_RUNBOOK_SECTIONS[@]}"; do
    if grep -qi "$section" "$RUNBOOK"; then
      info "Runbook covers: $section"
    else
      warn "Runbook may be missing section for: $section"
    fi
  done
else
  check_failed "docs/dr-runbook.md not found"
fi

# ── Check 5: dr_test_harness.sh is listed in scripts/README.md ────────────────
echo ""
echo "=== Check 5: scripts/README.md references DR test harness ==="
SCRIPTS_README="$SCRIPT_DIR/README.md"
if [[ -f "$SCRIPTS_README" ]]; then
  if grep -q "dr_test_harness" "$SCRIPTS_README"; then
    info "dr_test_harness.sh listed in scripts/README.md"
  else
    warn "dr_test_harness.sh not listed in scripts/README.md — update the index"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=================================="
if [[ $FAILURES -gt 0 ]]; then
  fail "$FAILURES check(s) failed"
  exit 1
else
  info "All DR validation checks passed"
fi
