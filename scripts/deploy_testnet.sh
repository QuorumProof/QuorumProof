#!/bin/bash
set -e

source .env

echo "Deploying to testnet..."

stellar keys generate deployer --network testnet 2>/dev/null || true

CONTRACT_QUORUM_PROOF=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/quorum_proof.wasm \
  --source deployer \
  --network testnet)

CONTRACT_SBT_REGISTRY=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/sbt_registry.wasm \
  --source deployer \
  --network testnet)

CONTRACT_ZK_VERIFIER=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/zk_verifier.wasm \
  --source deployer \
  --network testnet)

echo "CONTRACT_QUORUM_PROOF=$CONTRACT_QUORUM_PROOF"
echo "CONTRACT_SBT_REGISTRY=$CONTRACT_SBT_REGISTRY"
echo "CONTRACT_ZK_VERIFIER=$CONTRACT_ZK_VERIFIER"
