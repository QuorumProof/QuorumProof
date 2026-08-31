# QuorumProof Demo Script

This walkthrough demonstrates the core on-chain flow on a local `standalone` Stellar network:

1. Build the contracts
2. Deploy a `standalone` network
3. Create a quorum slice
4. Issue an SBT-backed credential
5. Attest it via the slice
6. Verify the claim

The commands below are intentionally conservative and intended to be copied into a fresh local environment. They match the repo’s current `standalone` setup conventions and avoid assuming a missing `demo/` directory or extra install steps.

## 1) Prerequisites

Make sure the required tooling is installed:

- Rust and Cargo
- Soroban CLI
- Stellar CLI
- `wasm32-unknown-unknown` target for contract builds

If needed, install the Rust target:

```bash
rustup target add wasm32-unknown-unknown
```

## 2) Build the contracts

From the repo root:

```bash
./scripts/build.sh
```

This builds the Soroban contracts for the release target.

## 3) Start a local standalone network

If you do not already have a standalone network running, launch one in a separate terminal:

```bash
stellar network start --local
```

Then confirm the network is registered and reachable:

```bash
stellar network list
```

You should see the local `standalone` network available.

## 4) Configure the environment

Use the local network for all commands below:

```bash
export STELLAR_NETWORK=standalone
export RPC_URL=http://localhost:8000/soroban/rpc
export NETWORK_PASSPHRASE="Standalone Network ; February 2017"
```

## 5) Deploy the contracts

The repo includes deployment helpers in `scripts/` for the `testnet` flow, but for a local standalone demo the simplest path is to deploy the wasm artifacts directly.

Build the contracts first, then deploy the `quorum_proof` and `zk_verifier` WASM files using the Soroban CLI:

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/quorum_proof.wasm \
  --network standalone
```

Record the returned contract ID, then deploy the `zk_verifier` contract:

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/zk_verifier.wasm \
  --network standalone
```

The exact command for `--source-account` or admin auth varies by your local Stellar CLI config, but a basic standalone deployment often works with the default funded account.

## 6) Initialize the contracts

Initialize the `quorum_proof` contract with an admin address:

```bash
soroban contract invoke \
  --id "$QUORUM_PROOF_CONTRACT_ID" \
  --network standalone \
  -- initialize \
  --admin "$ADMIN_ADDRESS"
```

Initialize the `zk_verifier` contract:

```bash
soroban contract invoke \
  --id "$ZK_VERIFIER_CONTRACT_ID" \
  --network standalone \
  -- initialize \
  --admin "$ADMIN_ADDRESS"
```

## 7) Create a quorum slice

Define a small trust set for a credential holder:

```bash
soroban contract invoke \
  --id "$QUORUM_PROOF_CONTRACT_ID" \
  --network standalone \
  --source-account "$ADMIN_ADDRESS" \
  -- create_slice \
  --issuer "$ADMIN_ADDRESS" \
  --attestors '["$ADMIN_ADDRESS","GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWSA","GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"]' \
  --weights '[1,1,1]' \
  --threshold 2
```

Record the resulting `slice_id` returned by the command.

## 8) Issue a credential

Issue a credential for the subject address:

```bash
soroban contract invoke \
  --id "$QUORUM_PROOF_CONTRACT_ID" \
  --network standalone \
  --source-account "$ADMIN_ADDRESS" \
  -- issue_credential \
  --issuer "$ADMIN_ADDRESS" \
  --subject "$SUBJECT_ADDRESS" \
  --credential-type 1 \
  --metadata-hash "a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2"
```

This returns the new `credential_id`.

## 9) Attest the credential

Use the slice created in step 7 to attest that credential:

```bash
soroban contract invoke \
  --id "$QUORUM_PROOF_CONTRACT_ID" \
  --network standalone \
  --source-account "$ADMIN_ADDRESS" \
  -- attest \
  --attestor "$ADMIN_ADDRESS" \
  --credential-id "$CREDENTIAL_ID" \
  --slice-id "$SLICE_ID"
```

The exact parameter names depend on the contract method signature in the current build; verify the generated contract interface with:

```bash
soroban contract inspect --wasm target/wasm32-unknown-unknown/release/quorum_proof.wasm
```

## 10) Verify the claim

The proof verification path is contract-specific and should use the current `zk_verifier` API for the chosen claim type. For a minimal proof check, ensure a verifying key is registered and then call the relevant verification method with a valid proof object.

```bash
soroban contract invoke \
  --id "$ZK_VERIFIER_CONTRACT_ID" \
  --network standalone \
  -- verify_claim \
  --admin "$ADMIN_ADDRESS" \
  --quorum-proof-id "$QUORUM_PROOF_CONTRACT_ID" \
  --credential-id "$CREDENTIAL_ID" \
  --claim-type 0 \
  --proof "00010203"
```

Because the actual proof format is cryptographically structured, the proof value must match the real verifying key and proof generation logic used by your circuit. For the fully documented current ZK behavior, see [docs/zk-verification-implementation.md](../docs/zk-verification-implementation.md).

## 11) Useful follow-ups

If you want to go beyond the minimal standalone flow, inspect the verification docs and the integration tests:

- [docs/zk-verification-implementation.md](../docs/zk-verification-implementation.md)
- [docs/TESTING_COMPREHENSIVE_GUIDE.md](../docs/TESTING_COMPREHENSIVE_GUIDE.md)
- [docs/E2E_TESTING.md](../docs/E2E_TESTING.md)
- [contracts/integration_tests/src/lib.rs](../contracts/integration_tests/src/lib.rs)

This demo intentionally does not claim a production-ready proof artifact; it demonstrates the repository’s supported standalone workflow and the fact that the proof verification path is a structured, versioned contract feature with specific constraints.
