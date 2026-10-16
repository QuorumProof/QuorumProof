# QuorumProof Snippet Examples

This directory demonstrates how the snippets from `.vscode/quorumproof.code-snippets` / `snippets/` are composed together to build production-grade QuorumProof contracts, client integrations, and unit tests.

## Included Examples

1. **[`credential_attestation_contract.rs`](./credential_attestation_contract.rs)**:
   A complete Soroban smart contract managing attestations and quorum verification, built using:
   - `qp-contract`: Base contract skeleton and storage keys
   - `qp-error-enum`: Typed contract error variants
   - `qp-require-auth`: Caller and admin authorization checks
   - `qp-storage-get` & `qp-storage-set`: Safe storage access with TTL management
   - `qp-quorum-slice`: Attestor quorum slice weight threshold evaluation
   - `qp-event-publish`: Publishing `verified` events on-chain

2. **[`verify_credential_client.ts`](./verify_credential_client.ts)**:
   A complete TypeScript client integration verifying off-chain credentials and submitting on-chain attestations, built using:
   - `qp-verify-credential`: Verifying signatures, timestamps, and claims
   - `qp-invoke-contract`: Calling Soroban smart contracts with Stellar SDK
   - `qp-ws-subscribe`: Real-time WebSocket event streaming with automatic reconnection

3. **[`contract_unit_test.rs`](./contract_unit_test.rs)**:
   A complete unit test suite for Soroban smart contracts, built using:
   - `qp-contract-test`: Test environment initialization, mock authorizations, and contract deployment
