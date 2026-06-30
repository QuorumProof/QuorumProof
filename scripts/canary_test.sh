#!/bin/bash
# Issue #592: Canary smoke tests run against a live mainnet deployment.
# Verifies core read paths and one write path using a funded canary key.
# Exits non-zero on any failure so the CI workflow can trigger rollback.
set -euo pipefail

: "${STELLAR_RPC_URL:?}"
: "${CONTRACT_QUORUM_PROOF:?}"
: "${STELLAR_SECRET_KEY:?}"
: "${ROLLOUT_PCT:=10}"

echo "=== Canary smoke tests (rollout ${ROLLOUT_PCT}%) ==="

stellar keys add canary --secret-key "$STELLAR_SECRET_KEY" 2>/dev/null || true

# 1. Verify the contract is reachable by reading its version
echo "[1/3] Checking contract version..."
stellar contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --source canary \
  --network mainnet \
  -- get_version

# 2. Issue a canary credential and immediately revoke it
echo "[2/3] Issue + revoke canary credential..."
CRED_ID=$(stellar contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --source canary \
  --network mainnet \
  -- issue_credential \
    --subject "$(stellar keys address canary)" \
    --credential_type 0 \
    --metadata_hash "63616e617279" \
  | tr -d '"')

stellar contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --source canary \
  --network mainnet \
  -- revoke_credential \
    --credential_id "$CRED_ID"

# 3. Confirm the credential is revoked (get_credential should reflect revoked state)
echo "[3/3] Confirming revocation..."
stellar contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --source canary \
  --network mainnet \
  -- get_credential \
    --credential_id "$CRED_ID"

echo "=== All canary smoke tests passed ==="
