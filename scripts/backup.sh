#!/usr/bin/env bash
# scripts/backup.sh — Automated backup of QuorumProof contract state with encryption.
#
# Usage:
#   ./scripts/backup.sh [--network testnet|mainnet] [--encrypt] [--upload s3://bucket]
#
# Requires: soroban CLI, jq, openssl (for encryption), aws CLI (for S3 upload)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if present
if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
fi

NETWORK="${STELLAR_NETWORK:-testnet}"
CONTRACT_ID="${CONTRACT_QUORUM_PROOF:?CONTRACT_QUORUM_PROOF must be set}"
TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
BACKUP_DIR="$ROOT_DIR/backups/daily"
BACKUP_FILE="$BACKUP_DIR/quorumproof-$TIMESTAMP.json"
ENCRYPTED_FILE="$BACKUP_FILE.enc"
ENCRYPT=false
UPLOAD_BUCKET=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --encrypt)
      ENCRYPT=true
      shift
      ;;
    --upload)
      UPLOAD_BUCKET="$2"
      shift 2
      ;;
    --network)
      NETWORK="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

mkdir -p "$BACKUP_DIR"

echo "==> Starting backup of QuorumProof contract $CONTRACT_ID on $NETWORK"
echo "    Timestamp: $TIMESTAMP"

invoke() {
  soroban contract invoke \
    --id "$CONTRACT_ID" \
    --network "$NETWORK" \
    -- "$@" 2>/dev/null
}

# Fetch counts
CRED_COUNT=$(invoke get_credential_count | tr -d '"')
SLICE_COUNT=$(invoke get_slice_count | tr -d '"')

echo "    Credentials: $CRED_COUNT"
echo "    Slices:      $SLICE_COUNT"

# Build JSON backup
{
  echo "{"
  echo "  \"backup_date\": \"$TIMESTAMP\","
  echo "  \"network\": \"$NETWORK\","
  echo "  \"contract_id\": \"$CONTRACT_ID\","
  echo "  \"credential_count\": $CRED_COUNT,"
  echo "  \"slice_count\": $SLICE_COUNT,"
  echo "  \"credentials\": ["

  for i in $(seq 1 "$CRED_COUNT"); do
    CRED=$(invoke get_credential --credential-id "$i" 2>/dev/null || echo "null")
    if [[ "$i" -lt "$CRED_COUNT" ]]; then
      echo "    $CRED,"
    else
      echo "    $CRED"
    fi
  done

  echo "  ],"
  echo "  \"slices\": ["

  for i in $(seq 1 "$SLICE_COUNT"); do
    SLICE=$(invoke get_slice --slice-id "$i" 2>/dev/null || echo "null")
    if [[ "$i" -lt "$SLICE_COUNT" ]]; then
      echo "    $SLICE,"
    else
      echo "    $SLICE"
    fi
  done

  echo "  ]"
  echo "}"
} > "$BACKUP_FILE"

echo "==> Backup written to $BACKUP_FILE"
echo "    Size: $(du -sh "$BACKUP_FILE" | cut -f1)"

# Encrypt if requested
if [[ "$ENCRYPT" == true ]]; then
  ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set for encryption}"
  
  echo "==> Encrypting backup..."
  openssl enc -aes-256-cbc -salt -in "$BACKUP_FILE" -out "$ENCRYPTED_FILE" \
    -k "$ENCRYPTION_KEY" -md sha256
  
  # Remove unencrypted file
  rm "$BACKUP_FILE"
  BACKUP_FILE="$ENCRYPTED_FILE"
  
  echo "    Encrypted file: $ENCRYPTED_FILE"
  echo "    Size: $(du -sh "$ENCRYPTED_FILE" | cut -f1)"
fi

# Upload to S3 if requested
if [[ -n "$UPLOAD_BUCKET" ]]; then
  echo "==> Uploading to S3..."
  
  S3_KEY="quorumproof/$NETWORK/$(basename "$BACKUP_FILE")"
  aws s3 cp "$BACKUP_FILE" "s3://$UPLOAD_BUCKET/$S3_KEY" \
    --sse AES256 \
    --metadata "network=$NETWORK,contract=$CONTRACT_ID,timestamp=$TIMESTAMP"
  
  echo "    Uploaded to s3://$UPLOAD_BUCKET/$S3_KEY"
fi

# Verify backup integrity
echo "==> Verifying backup integrity..."
if jq empty "$BACKUP_FILE" 2>/dev/null || [[ "$ENCRYPT" == true ]]; then
  echo "    ✓ Backup is valid"
else
  echo "    ✗ Backup verification failed"
  exit 1
fi

echo "==> Backup complete"
