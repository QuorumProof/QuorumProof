# ADR-014: Admin Circuit Breaker (Pause) and Per-Address Rate Limiting

## Status

Accepted

## Date

2026-09-26

## Context

QuorumProof is meant to be trustless in steady state. Early in its life,
though, it may ship bugs, and a compromised issuer or attestor key could flood
the system with bogus credentials or attestations. Once written, on-chain state
can't be taken back, so the only defences are stopping writes quickly and
limiting how fast they happen.

## Problem Statement

What operational safety controls should the contracts have, and who controls them?

## Alternatives Considered

### Option 1: No admin controls (fully immutable)

**Pros**: Maximally trustless. No admin key to compromise.

**Cons**: No response is possible to an exploit in progress. Unacceptable
before an external audit.

### Option 2: Admin pause plus rate limiting (chosen)

**Pros**: Incident response is possible. Abuse is bounded even without human
intervention.

**Cons**: The admin is a trusted party, and the rate limit adds cost to every
write.

### Option 3: Governance / DAO-controlled pause

**Pros**: No single trusted key.

**Cons**: Too slow for incident response, and there is no governance body yet.

## Decision

- **Pause**: `pause(admin)` and `unpause(admin)` flip `DataKey::Paused`.
  Credential and attestation write paths call `require_not_paused` and fail
  with `ContractError::ContractPaused`. Reads keep working while paused, so
  verifiers aren't disrupted. Upgrades are also blocked while paused
  ([ADR-011](./adr-011-state-versioning-and-upgrades.md)), so a pause can't be
  used to push an unreviewed upgrade in the middle of an incident.
- **Rate limiting**: `require_rate_limit(address)` enforces
  `RateLimitConfig { max_calls, window_seconds }` per caller, with state in
  `DataKey2::RateLimitState(address)`. It returns
  `ContractError::RateLimitExceeded` when the limit is hit.
- `sbt_registry` and `zk_verifier` have their own admin `pause` for their
  write paths (minting, proof verification).
- The admin is set once at `initialize` and should be a multisig account on mainnet.

## Rationale

Pausing gives responders time to act without deleting data. Rate limiting
bounds the damage a leaked issuer or attestor key can do before anyone notices.
Keeping reads open during a pause preserves the main thing the system
guarantees, which is that existing credentials can always be verified.

## Consequences

### Positive

- Incidents can be contained within a single transaction.
- Automated abuse is bounded without human intervention.

### Negative

- The admin key is a centralisation point and a high-value target.
- Rate-limit bookkeeping adds a storage write to every rate-limited call.

### Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Admin key compromise | Low | Critical | Multisig admin; admin actions emit events for monitoring |
| Admin pauses indefinitely (censorship) | Low | High | Reads are unaffected; long-term plan is governance-controlled admin |
| Legitimate bulk issuers throttled | Med | Low | `RateLimitConfig` is admin-tunable; batch endpoints |

## Related Code

- `contracts/quorum_proof/src/lib.rs`: `pause`, `unpause`, `is_paused`, `require_not_paused`, `require_rate_limit`, `set_rate_limit_config`, `RateLimitConfig`
- `contracts/sbt_registry/src/lib.rs`, `contracts/zk_verifier/src/lib.rs`: `pause`
- `docs/disaster-recovery.md`: incident runbook

## References

- [docs/threat-model.md](../threat-model.md)
- [docs/security-audit-checklist.md](../security-audit-checklist.md)
