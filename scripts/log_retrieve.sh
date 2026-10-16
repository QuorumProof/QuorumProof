#!/usr/bin/env bash
# scripts/log_retrieve.sh — #1653 Retrieve archived logs from cold storage.
#
# Finds archived log objects for a date range, restores any that are in an
# asynchronous-retrieval tier (DEEP_ARCHIVE / GLACIER), downloads them, and
# optionally filters them. Retrieval is logged to an audit trail
# (retrievals.log in the output directory, plus the S3 access logs) because
# log access is itself a compliance-relevant event.
#
# Usage:
#   scripts/log_retrieve.sh --from 2026-01-01 --to 2026-01-07 [options]
#
# Options:
#   --source file|cloudwatch   file: archives from scripts/log_archive.sh (default)
#                              cloudwatch: Firehose archives (infra/terraform/modules/log-archive)
#   --host <id>                only this host (file source)
#   --output <dir>             download directory [./restored-logs]
#   --grep <regex>             write matching lines to <output>/matches.jsonl
#   --tier Standard|Bulk|Expedited
#                              Glacier restore tier [Standard]. DEEP_ARCHIVE:
#                              Standard ≈ 12h, Bulk ≈ 48h (Expedited not supported).
#   --restore-days <n>         how long restored copies stay available [7]
#   --reason "<text>"          required: why the logs are being retrieved
#
# Environment:
#   LOG_ARCHIVE_BUCKET   S3 archive bucket (omit to read LOG_ARCHIVE_DIR)
#   LOG_ARCHIVE_PREFIX   [logs]
#   LOG_ARCHIVE_DIR      [/var/lib/quorumproof/log-archive]
#
# Exit codes: 0 all objects downloaded, 3 some objects still being restored
# (re-run later with the same arguments), 1/2 errors.

set -euo pipefail

FROM=""; TO=""; SOURCE="file"; HOST=""; OUTPUT="./restored-logs"; GREP=""
TIER="Standard"; RESTORE_DAYS=7; REASON=""
LOG_ARCHIVE_BUCKET="${LOG_ARCHIVE_BUCKET:-}"
LOG_ARCHIVE_PREFIX="${LOG_ARCHIVE_PREFIX:-logs}"
LOG_ARCHIVE_DIR="${LOG_ARCHIVE_DIR:-/var/lib/quorumproof/log-archive}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --to) TO="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --grep) GREP="$2"; shift 2 ;;
    --tier) TIER="$2"; shift 2 ;;
    --restore-days) RESTORE_DAYS="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$FROM" && -n "$TO" ]] || { echo "error: --from and --to are required (YYYY-MM-DD)" >&2; exit 2; }
[[ -n "$REASON" ]] || { echo "error: --reason is required (retrievals are audited)" >&2; exit 2; }
[[ "$SOURCE" == "file" || "$SOURCE" == "cloudwatch" ]] || { echo "error: --source must be file or cloudwatch" >&2; exit 2; }
date -u -d "$FROM" >/dev/null && date -u -d "$TO" >/dev/null || { echo "error: invalid date" >&2; exit 2; }

mkdir -p "$OUTPUT"
echo "$(date -u +%FT%TZ) user=${USER:-unknown} from=$FROM to=$TO source=$SOURCE host=${HOST:-*} reason=\"$REASON\"" >> "$OUTPUT/retrievals.log"

log() { printf '==> %s\n' "$*"; }

days() {
  local d="$FROM"
  while [[ "$(date -u -d "$d" +%s)" -le "$(date -u -d "$TO" +%s)" ]]; do
    date -u -d "$d" +%Y/%m/%d
    d=$(date -u -d "$d + 1 day" +%F)
  done
}

pending=0
downloaded=0

if [[ -z "$LOG_ARCHIVE_BUCKET" ]]; then
  [[ "$SOURCE" == "file" ]] || { echo "error: cloudwatch source requires LOG_ARCHIVE_BUCKET" >&2; exit 2; }
  log "reading local archive $LOG_ARCHIVE_DIR"
  while read -r day; do
    for dir in "$LOG_ARCHIVE_DIR"/${HOST:-*}/"$day"; do
      [[ -d "$dir" ]] || continue
      (cd "$dir" && sha256sum --quiet -c SHA256SUMS) || { echo "error: checksum mismatch in $dir" >&2; exit 1; }
      rel="${dir#"$LOG_ARCHIVE_DIR"/}" # <host>/YYYY/MM/DD
      mkdir -p "$OUTPUT/$rel"
      for f in "$dir"/*.log.gz; do
        [[ -f "$f" ]] || continue
        cp -p "$f" "$OUTPUT/$rel/"
        downloaded=$((downloaded + 1))
      done
    done
  done < <(days)
else
  command -v aws >/dev/null 2>&1 || { echo "error: aws CLI is required" >&2; exit 2; }
  while read -r day; do
    if [[ "$SOURCE" == "cloudwatch" ]]; then
      # Firehose partitions by date directly under cloudwatch/.
      objects=$(aws s3api list-objects-v2 --bucket "$LOG_ARCHIVE_BUCKET" --prefix "cloudwatch/$day/" \
        --query 'Contents[].[Key,StorageClass]' --output text)
    else
      # File archives are keyed <prefix>/<host>/YYYY/MM/DD/; without --host,
      # list every host and keep the requested day.
      objects=$(aws s3api list-objects-v2 --bucket "$LOG_ARCHIVE_BUCKET" \
        --prefix "$LOG_ARCHIVE_PREFIX/${HOST:+$HOST/}" \
        --query 'Contents[].[Key,StorageClass]' --output text | grep -F "/$day/" || true)
    fi

    while read -r key class; do
      [[ -n "$key" && "$key" != "None" ]] || continue
      dest="$OUTPUT/$key"
      [[ -f "$dest" ]] && { downloaded=$((downloaded + 1)); continue; }

      if [[ "$class" == "DEEP_ARCHIVE" || "$class" == "GLACIER" ]]; then
        restore=$(aws s3api head-object --bucket "$LOG_ARCHIVE_BUCKET" --key "$key" --query Restore --output text 2>/dev/null || echo "None")
        if [[ "$restore" == "None" ]]; then
          log "requesting $TIER restore of $key ($class)"
          aws s3api restore-object --bucket "$LOG_ARCHIVE_BUCKET" --key "$key" \
            --restore-request "{\"Days\":$RESTORE_DAYS,\"GlacierJobParameters\":{\"Tier\":\"$TIER\"}}"
          pending=$((pending + 1)); continue
        elif [[ "$restore" == *'ongoing-request="true"'* ]]; then
          log "restore in progress: $key"
          pending=$((pending + 1)); continue
        fi
      fi

      mkdir -p "$(dirname "$dest")"
      aws s3 cp "s3://$LOG_ARCHIVE_BUCKET/$key" "$dest" --only-show-errors
      expected=$(aws s3api head-object --bucket "$LOG_ARCHIVE_BUCKET" --key "$key" --query 'Metadata.sha256' --output text 2>/dev/null || echo "None")
      if [[ "$expected" != "None" && "$expected" != "$(sha256sum "$dest" | awk '{print $1}')" ]]; then
        echo "error: checksum mismatch for $key" >&2; exit 1
      fi
      downloaded=$((downloaded + 1))
    done <<<"$objects"
  done < <(days)
fi

log "downloaded: $downloaded, pending restore: $pending"

if [[ -n "$GREP" && $downloaded -gt 0 ]]; then
  log "filtering with /$GREP/ → $OUTPUT/matches.jsonl"
  # Firehose CloudWatch objects are gzip-compressed JSON envelopes; file
  # archives are gzip'd JSON lines. zgrep handles both.
  find "$OUTPUT" -type f ! -name 'retrievals.log' ! -name 'matches.jsonl' -print0 \
    | xargs -0 -r zgrep -hE "$GREP" 2>/dev/null > "$OUTPUT/matches.jsonl" || true
  log "$(wc -l < "$OUTPUT/matches.jsonl") matching lines"
fi

if [[ $pending -gt 0 ]]; then
  log "$pending object(s) are being restored from cold storage — re-run this command later."
  exit 3
fi
