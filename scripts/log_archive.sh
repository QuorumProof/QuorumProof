#!/usr/bin/env bash
# scripts/log_archive.sh — #1653 Log retention enforcement + cold-storage archival.
#
# For hosts / docker-compose deployments that write file logs
# (/var/log/quorumproof/*.log, see api-server/src/services/logger.ts). In AWS
# the same policy is enforced by CloudWatch retention + the Firehose → S3
# pipeline in infra/terraform/modules/log-archive; this script is the
# equivalent for everything else.
#
# One run does, in order:
#   1. rotate   — copy-truncate each active *.log whose size exceeds
#                 LOG_ROTATE_MAX_MB (or that was last rotated > 1 day ago) into
#                 <name>-<UTC timestamp>.log and gzip it. copy-truncate is used
#                 because pino holds the file descriptor open.
#   2. archive  — upload every rotated *.log.gz to cold storage with a SHA-256
#                 manifest entry. Destination:
#                   s3://$LOG_ARCHIVE_BUCKET/$LOG_ARCHIVE_PREFIX/<host>/YYYY/MM/DD/
#                 (storage class $LOG_ARCHIVE_STORAGE_CLASS, default GLACIER_IR),
#                 or $LOG_ARCHIVE_DIR on local/NFS storage when no bucket is set.
#   3. prune    — delete local rotated files older than LOG_LOCAL_RETENTION_DAYS
#                 **only if** they were archived successfully (manifest entry).
#   4. expire   — for LOG_ARCHIVE_DIR archives only (S3 uses lifecycle rules),
#                 delete archived files older than LOG_ARCHIVE_RETENTION_DAYS,
#                 skipping anything listed in $LOG_ARCHIVE_DIR/LEGAL_HOLD.
#
# Usage:
#   scripts/log_archive.sh [--dry-run] [--once | --loop <seconds>]
#
# Environment (defaults in brackets):
#   LOG_DIR                     [/var/log/quorumproof]
#   LOG_ROTATE_MAX_MB           [100]
#   LOG_LOCAL_RETENTION_DAYS    [7]
#   LOG_ARCHIVE_BUCKET          [] — enables S3 archival
#   LOG_ARCHIVE_PREFIX          [logs]
#   LOG_ARCHIVE_STORAGE_CLASS   [GLACIER_IR]
#   LOG_ARCHIVE_DIR             [/var/lib/quorumproof/log-archive]
#   LOG_ARCHIVE_RETENTION_DAYS  [2555] (7 years)
#
# Requires: gzip, sha256sum; aws CLI when LOG_ARCHIVE_BUCKET is set.

set -euo pipefail

LOG_DIR="${LOG_DIR:-/var/log/quorumproof}"
LOG_ROTATE_MAX_MB="${LOG_ROTATE_MAX_MB:-100}"
LOG_LOCAL_RETENTION_DAYS="${LOG_LOCAL_RETENTION_DAYS:-7}"
LOG_ARCHIVE_BUCKET="${LOG_ARCHIVE_BUCKET:-}"
LOG_ARCHIVE_PREFIX="${LOG_ARCHIVE_PREFIX:-logs}"
LOG_ARCHIVE_STORAGE_CLASS="${LOG_ARCHIVE_STORAGE_CLASS:-GLACIER_IR}"
LOG_ARCHIVE_DIR="${LOG_ARCHIVE_DIR:-/var/lib/quorumproof/log-archive}"
LOG_ARCHIVE_RETENTION_DAYS="${LOG_ARCHIVE_RETENTION_DAYS:-2555}"
HOST_ID="${HOST_ID:-$(hostname)}"

DRY_RUN=0
LOOP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --once) LOOP=0; shift ;;
    --loop) LOOP="$2"; shift 2 ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

MANIFEST="$LOG_DIR/.archive-manifest"
STATE_DIR="$LOG_DIR/.rotate-state"

log() { printf '%s [log-archive] %s\n' "$(date -u +%FT%TZ)" "$*"; }

act() {
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] $*"
  else
    "$@"
  fi
}

rotate() {
  mkdir -p "$STATE_DIR"
  local max_bytes=$((LOG_ROTATE_MAX_MB * 1024 * 1024))
  local now
  now=$(date -u +%s)

  shopt -s nullglob
  for f in "$LOG_DIR"/*.log; do
    local name size stamp last=0
    name=$(basename "$f" .log)
    size=$(stat -c %s "$f")
    [[ -f "$STATE_DIR/$name" ]] && last=$(cat "$STATE_DIR/$name")
    if [[ "$size" -eq 0 ]]; then continue; fi
    if [[ "$size" -lt "$max_bytes" && $((now - last)) -lt 86400 ]]; then continue; fi

    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    local rotated="$LOG_DIR/$name-$stamp.log"
    log "rotate $f ($size bytes) → $(basename "$rotated").gz"
    act cp -p "$f" "$rotated"
    act truncate -s 0 "$f"
    act gzip -9 "$rotated"
    [[ $DRY_RUN -eq 1 ]] || echo "$now" > "$STATE_DIR/$name"
  done
}

archive_one() {
  local f="$1" base day_path
  base=$(basename "$f")
  # name-YYYYMMDDTHHMMSSZ.log.gz → YYYY/MM/DD
  if [[ "$base" =~ -([0-9]{4})([0-9]{2})([0-9]{2})T[0-9]{6}Z\.log\.gz$ ]]; then
    day_path="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}/${BASH_REMATCH[3]}"
  else
    day_path=$(date -u -r "$f" +%Y/%m/%d)
  fi

  local sha
  sha=$(sha256sum "$f" | awk '{print $1}')

  if [[ -n "$LOG_ARCHIVE_BUCKET" ]]; then
    local dest="s3://$LOG_ARCHIVE_BUCKET/$LOG_ARCHIVE_PREFIX/$HOST_ID/$day_path/$base"
    log "archive $base → $dest ($LOG_ARCHIVE_STORAGE_CLASS)"
    act aws s3 cp "$f" "$dest" --only-show-errors \
      --storage-class "$LOG_ARCHIVE_STORAGE_CLASS" \
      --metadata "sha256=$sha,host=$HOST_ID" || return 1
    [[ $DRY_RUN -eq 1 ]] || echo "$base $sha $dest $(date -u +%FT%TZ)" >> "$MANIFEST"
  else
    local dest_dir="$LOG_ARCHIVE_DIR/$HOST_ID/$day_path"
    log "archive $base → $dest_dir/"
    act mkdir -p "$dest_dir"
    act cp -p "$f" "$dest_dir/$base" || return 1
    if [[ $DRY_RUN -eq 0 ]]; then
      echo "$sha  $base" >> "$dest_dir/SHA256SUMS"
      echo "$base $sha $dest_dir/$base $(date -u +%FT%TZ)" >> "$MANIFEST"
    fi
  fi
}

archive() {
  touch "$MANIFEST"
  shopt -s nullglob
  local failures=0
  for f in "$LOG_DIR"/*.log.gz; do
    grep -q "^$(basename "$f") " "$MANIFEST" && continue
    archive_one "$f" || { log "ERROR: failed to archive $f"; failures=$((failures + 1)); }
  done
  return "$failures"
}

prune_local() {
  shopt -s nullglob
  while IFS= read -r -d '' f; do
    if grep -q "^$(basename "$f") " "$MANIFEST"; then
      log "prune local $(basename "$f") (older than ${LOG_LOCAL_RETENTION_DAYS}d, archived)"
      act rm -f "$f"
    else
      log "WARN: keeping $(basename "$f") — not yet archived"
    fi
  done < <(find "$LOG_DIR" -maxdepth 1 -name '*.log.gz' -mtime "+$LOG_LOCAL_RETENTION_DAYS" -print0)
}

expire_archive() {
  [[ -n "$LOG_ARCHIVE_BUCKET" ]] && return 0 # S3 lifecycle rules handle expiry
  [[ -d "$LOG_ARCHIVE_DIR" ]] || return 0
  local hold="$LOG_ARCHIVE_DIR/LEGAL_HOLD"
  while IFS= read -r -d '' f; do
    if [[ -f "$hold" ]] && grep -qF "$(basename "$f")" "$hold"; then
      log "legal hold: keeping $(basename "$f")"
      continue
    fi
    log "expire archived $(basename "$f") (older than ${LOG_ARCHIVE_RETENTION_DAYS}d)"
    act rm -f "$f"
  done < <(find "$LOG_ARCHIVE_DIR" -type f -name '*.log.gz' -mtime "+$LOG_ARCHIVE_RETENTION_DAYS" -print0)
}

run_once() {
  [[ -d "$LOG_DIR" ]] || { log "log dir $LOG_DIR does not exist — nothing to do"; return 0; }
  rotate
  local rc=0
  archive || rc=$?
  prune_local
  expire_archive
  if [[ $rc -ne 0 ]]; then
    log "completed with $rc archive failure(s); failed files stay local and are retried next run"
    return 1
  fi
  log "completed"
}

if [[ "$LOOP" -gt 0 ]]; then
  log "running every ${LOOP}s"
  while true; do
    run_once || true
    sleep "$LOOP"
  done
else
  run_once
fi
