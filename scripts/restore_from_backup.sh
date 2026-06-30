#!/usr/bin/env bash
# scripts/restore_from_backup.sh — Restore QuorumProof contract state from encrypted backup.
#
# Usage:
#   ./scripts/restore_from_backup.sh --backup path/to/backup.json [--contract ID] [--network testnet]
#
# Requires: soroban CLI, jq, openssl (for decryption)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if present
if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
fi

BACKUP_FILE=""
CONTRACT_ID="${CONTRACT_QUORUM_PROOF}"
NETWORK="${STELLAR_NETWORK:-testnet}"
TEMP_DIR=$(mktemp -d)

# Cleanup temp directory on exit
trap "rm -rf $TEMP_DIR" EXIT

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --backup)
      BACKUP_FILE="$2"
      shift 2
      ;;
    --contract)
      CONTRACT_ID="$2"
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

if [[ -z "$BACKUP_FILE" ]]; then
  echo "Error: --backup is required"
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

if [[ -z "$CONTRACT_ID" ]]; then
  echo "Error: CONTRACT_QUORUM_PROOF must be set or --contract provided"
  exit 1
fi

echo "==> Starting restore from backup"
echo "    Backup file: $BACKUP_FILE"
echo "    Contract ID: $CONTRACT_ID"
echo "    Network: $NETWORK"

# Decrypt if encrypted
WORKING_FILE="$BACKUP_FILE"
if [[ "$BACKUP_FILE" == *.enc ]]; then
  echo "==> Decrypting backup..."
  ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set for encrypted backups}"
  
  WORKING_FILE="$TEMP_DIR/backup.json"
  openssl enc -aes-256-cbc -d -in "$BACKUP_FILE" -out "$WORKING_FILE" \
    -k "$ENCRYPTION_KEY" -md sha256
  
  echo "    Decrypted successfully"
fi

# Verify backup structure
echo "==> Verifying backup structure..."
if ! jq empty "$WORKING_FILE" 2>/dev/null; then
  echo "Error: Backup file is not valid JSON"
  exit 1
fi

BACKUP_CRED_COUNT=$(jq '.credential_count' "$WORKING_FILE")
BACKUP_SLICE_COUNT=$(jq '.slice_count' "$WORKING_FILE")

echo "    Credentials in backup: $BACKUP_CRED_COUNT"
echo "    Slices in backup: $BACKUP_SLICE_COUNT"

# Verify current contract state
echo "==> Verifying current contract state..."
invoke() {
  soroban contract invoke \
    --id "$CONTRACT_ID" \
    --network "$NETWORK" \
    -- "$@" 2>/dev/null
}

CURRENT_CRED_COUNT=$(invoke get_credential_count | tr -d '"')
CURRENT_SLICE_COUNT=$(invoke get_slice_count | tr -d '"')

echo "    Current credentials: $CURRENT_CRED_COUNT"
echo "    Current slices: $CURRENT_SLICE_COUNT"

# Restore credentials
echo "==> Restoring credentials..."
RESTORED_CREDS=0

for i in $(seq 0 $((BACKUP_CRED_COUNT - 1))); do
  CRED=$(jq ".credentials[$i]" "$WORKING_FILE")
  
  # Extract credential fields
  SUBJECT=$(echo "$CRED" | jq -r '.subject')
  ISSUER=$(echo "$CRED" | jq -r '.issuer')
  CRED_TYPE=$(echo "$CRED" | jq -r '.credential_type')
  METADATA_HASH=$(echo "$CRED" | jq -r '.metadata_hash')
  EXPIRES_AT=$(echo "$CRED" | jq -r '.expires_at')
  
  # Issue credential
  if invoke issue_credential \
    --subject "$SUBJECT" \
    --credential-type "$CRED_TYPE" \
    --metadata-hash "$METADATA_HASH" \
    --expires-at "$EXPIRES_AT" > /dev/null 2>&1; then
    ((RESTORED_CREDS++))
  fi
done

echo "    Restored $RESTORED_CREDS credentials"

# Restore slices
echo "==> Restoring quorum slices..."
RESTORED_SLICES=0

for i in $(seq 0 $((BACKUP_SLICE_COUNT - 1))); do
  SLICE=$(jq ".slices[$i]" "$WORKING_FILE")
  
  # Extract slice fields
  CREATOR=$(echo "$SLICE" | jq -r '.creator')
  THRESHOLD=$(echo "$SLICE" | jq -r '.threshold')
  ATTESTORS=$(echo "$SLICE" | jq -r '.attestors | join(",")')
  
  # Create slice
  if invoke create_slice \
    --creator "$CREATOR" \
    --attestors "$ATTESTORS" \
    --threshold "$THRESHOLD" > /dev/null 2>&1; then
    ((RESTORED_SLICES++))
  fi
done

echo "    Restored $RESTORED_SLICES slices"

# Verify restoration
echo "==> Verifying restoration..."
FINAL_CRED_COUNT=$(invoke get_credential_count | tr -d '"')
FINAL_SLICE_COUNT=$(invoke get_slice_count | tr -d '"')

echo "    Final credentials: $FINAL_CRED_COUNT"
echo "    Final slices: $FINAL_SLICE_COUNT"

if [[ $FINAL_CRED_COUNT -ge $BACKUP_CRED_COUNT ]] && [[ $FINAL_SLICE_COUNT -ge $BACKUP_SLICE_COUNT ]]; then
  echo "==> Restoration complete and verified"
else
  echo "Warning: Restoration may be incomplete"
  echo "  Expected at least $BACKUP_CRED_COUNT credentials, got $FINAL_CRED_COUNT"
  echo "  Expected at least $BACKUP_SLICE_COUNT slices, got $FINAL_SLICE_COUNT"
fi
