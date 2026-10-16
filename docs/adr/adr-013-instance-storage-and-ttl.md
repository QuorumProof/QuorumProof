# ADR-013: Instance Storage and TTL Strategy

## Status

Accepted. Revisit before mainnet scale (see Risks).

## Date

2026-09-26

## Context

Soroban has three storage types, each with its own cost model and lifetime:

| Type | Lifetime | Loaded | Typical use |
|---|---|---|---|
| `instance` | Shares the contract instance's TTL | On **every** invocation, all at once | Config, admin, small counters |
| `persistent` | Own TTL per entry, restorable after archival | Per key, on access | Durable per-user records |
| `temporary` | Own TTL, deleted when it expires | Per key | Caches, nonces |

Entries whose TTL runs out are archived and must be restored before they can
be read again.

## Problem Statement

Which storage type should QuorumProof use for credentials, slices and
attestations, and how are TTLs kept alive?

## Alternatives Considered

### Option 1: Instance storage for everything (current)

**Pros**: Simplest code. One `extend_ttl` call keeps all state alive. No
per-entry archival or restore handling.

**Cons**: The whole instance is loaded on every call, so the read cost of every
call grows with the total number of credentials. Instance storage has a hard
size limit, so this design has a ceiling on total state.

### Option 2: Persistent storage for per-record data, instance for config

**Pros**: Cost per call doesn't depend on the total number of records. No
global size ceiling.

**Cons**: A TTL for each entry. Records nobody touches for a long time are
archived and need a restore. More code paths.

### Option 3: Temporary storage for caches

**Pros**: Cheap, and expires on its own.

**Cons**: Only suitable for data that can be rebuilt.

## Decision

For the current (testnet / early-adopter) phase:

- `quorum_proof` and `zk_verifier` keep their state in **instance** storage.
  Every state-changing call runs
  `extend_ttl(STANDARD_TTL = 16_384, EXTENDED_TTL = 524_288)` ledgers.
- `sbt_registry` already uses **persistent** storage for token records, because
  tokens are held long-term and read one at a time. Delegations followed in
  [ADR-008](./adr-008-delegation-persistent-storage-migration.md).
- Before mainnet scale, per-record keys (`Credential`, `Slice`, `Attestors`,
  `SubjectCredentials`, audit trails) move to persistent storage through a
  `migrate_state` step, as [ADR-011](./adr-011-state-versioning-and-upgrades.md)
  describes.

## Rationale

While there are few records, instance storage keeps the contract simple and
rules out a whole class of "archived entry" failures. Recording the planned
move now makes it a deliberate step, not a surprise when the size limit is
reached.

## Consequences

### Positive

- Simple, uniform storage access, and a single TTL to manage.
- No archival or restore edge cases during early adoption.

### Negative

- Every call gets more expensive as the number of credentials grows.
- There is a hard ceiling on total state until the move to persistent storage.

### Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Instance storage reaches its size limit | High at scale | Critical | Planned persistent-storage migration; monitor instance size in `monitoring/` |
| Fees rise as the credential count grows | High | Med | Benchmarks in `benches/`; migrate before fees become material |
| Contract instance expires because no one calls it | Low | Critical | Every write extends the TTL; the ops runbook includes a periodic `extend_ttl` |

## Related Code

- `contracts/quorum_proof/src/lib.rs`: `STANDARD_TTL`, `EXTENDED_TTL`, `DataKey`, `DataKey2`
- `contracts/sbt_registry/src/lib.rs`: persistent token storage
- `contracts/zk_verifier/src/lib.rs`: `DataKey`

## References

- [ADR-008: Delegation persistent storage migration](./adr-008-delegation-persistent-storage-migration.md)
- [Soroban state archival](https://developers.stellar.org/docs/learn/encyclopedia/storage/state-archival)
- [Soroban storage types](https://developers.stellar.org/docs/build/guides/storage/choosing-the-right-storage)
