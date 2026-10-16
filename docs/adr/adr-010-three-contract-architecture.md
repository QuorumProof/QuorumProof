# ADR-010: Split the System into Three Soroban Contracts

## Status

Accepted

## Date

2026-09-26

## Context

QuorumProof has three separate concerns:

1. **Credential and trust logic**: issuing credentials, defining quorum slices,
   collecting attestations and deciding whether a credential is attested.
2. **Token representation**: a non-transferable token (SBT) that a holder can
   present as proof of a credential.
3. **Claim verification**: proving statements about a credential ("has a
   mechanical engineering degree") without revealing it. This is a stub today
   (see [ADR-003](./adr-003-zk-verification.md)).

These concerns change at different rates and carry different risks. The
verification logic will be replaced wholesale when real Groth16/PLONK
verification lands. Token logic is small and should rarely change.

## Problem Statement

Should QuorumProof be one contract or several? If several, how do they
communicate?

## Alternatives Considered

### Option 1: Single monolithic contract

**Pros**: No cross-contract calls, one address, one upgrade, atomic state.

**Cons**: WASM size limits. `quorum_proof` alone is already large. Swapping out
the ZK verifier would mean upgrading the entire credential store. Every change
widens the review scope for security-critical code.

### Option 2: Three contracts with crate dependencies

`sbt_registry` imports `quorum_proof` as a Rust crate and uses its generated client.

**Pros**: Type-safe cross-contract calls.

**Cons**: Circular crate dependency once `quorum_proof` needs to reference
`sbt_registry`. Bundling another contract's code into a WASM also inflates it.

### Option 3: Three contracts, calls via `env.invoke_contract` (chosen)

**Pros**: Independent deploy and upgrade cycles. Each WASM stays small. No
circular dependencies. Blast radius is limited per contract.

**Cons**: Stringly-typed cross-contract calls (function name as a `Symbol`,
arguments as `Val`) that the compiler can't check. Three addresses to configure
and to keep consistent across networks.

## Decision

Deploy three contracts:

| Contract | Responsibility |
|---|---|
| `quorum_proof` | Credentials, slices, attestations, disputes, recovery, admin controls |
| `sbt_registry` | Soulbound tokens; checks credential status in `quorum_proof` before minting |
| `zk_verifier` | Claim verification (stub), verifying keys, proof metadata |

Cross-contract calls in production code go through `env.invoke_contract`,
using peer addresses stored in contract configuration:

- `sbt_registry` → `quorum_proof` (credential status checks before minting);
- `quorum_proof` → `zk_verifier` (`verify_groth16_proof`);
- `quorum_proof` → `sbt_registry` (`get_tokens_by_owner`).

Crate dependencies between contracts are allowed only as dev-dependencies
(generated clients for tests). This avoids circular crate dependencies and
keeps other contracts' code out of each WASM.

## Rationale

The ZK verifier is the component most likely to be rewritten, and credential
storage is the component that should change least. Keeping them apart means a
verifier upgrade can't corrupt credential state (see
[ADR-011](./adr-011-state-versioning-and-upgrades.md)).

## Consequences

### Positive

- Each contract can be upgraded, audited and rolled back on its own.
- Smaller WASMs, which leaves headroom under network size limits.

### Negative

- Cross-contract calls are not type-checked. A renamed `quorum_proof` function
  breaks `sbt_registry` at runtime.
- Deployment has to wire the addresses together (`sbt_registry.initialize(admin, qp_id)`).

### Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `quorum_proof` renames or removes a function that `sbt_registry` invokes | Med | High | `scripts/upgrade/check_state_compat.py` fails on removed/changed public functions; integration tests in `contracts/integration_tests` exercise cross-contract paths |
| Contracts on a network point to wrong peer addresses | Low | High | `environments.toml` + deploy scripts; address checks in the deployment guide |
| Cross-contract call failure leaves partial state | Low | Med | Chaos tests (`contracts/integration_tests/src/chaos.rs`) |

## Related Code

- `contracts/quorum_proof/src/lib.rs`: `QuorumProofContract`
- `contracts/sbt_registry/src/lib.rs`: `invoke_contract` calls to `quorum_proof`
- `contracts/quorum_proof/Cargo.toml`: peer contracts as dev-dependencies only
- `contracts/zk_verifier/src/lib.rs`: `ZkVerifierContract`
- `Cargo.toml`: workspace members

## References

- [ADR-004: Soroban platform choice](./adr-004-soroban-platform.md)
- [docs/architecture.md](../architecture.md)
- [Soroban cross-contract calls](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/cross-contract-call)
