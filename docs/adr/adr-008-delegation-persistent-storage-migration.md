# ADR-008: Migrate Delegation Storage from Instance to Persistent

**Status**: Accepted  
**Date**: 2026-08-27  
**Issue**: #1411  

## Context

`DataKey::Delegation(token_id)` and `DataKey::UsageDelegation(sbt_id, delegatee)` were
previously stored in `env.storage().instance()`.

Instance storage is a **single shared entry** for the entire contract.  Every write bumps
and grows the instance footprint, and instance entries share no per-entry TTL.  All other
per-entity records in `sbt_registry` (Token, Owner, OwnerTokens, CompressedMetadata, etc.)
use `env.storage().persistent()` with an explicit `extend_ttl(STANDARD_TTL, EXTENDED_TTL)`.
The inconsistency means delegations do not benefit from the same archival policy and
silently accumulate instance storage.

## Decision

Migrate all reads, writes, and removes of `Delegation` and `UsageDelegation` to
`env.storage().persistent()`.  Every write is followed by:

```rust
env.storage().persistent().extend_ttl(&key, STANDARD_TTL, EXTENDED_TTL);
```

matching the pattern used by `Token`, `Owner`, etc.

Affected call-sites:

| Function | Change |
|---|---|
| `delegate_sbt_rights` | `instance().set` → `persistent().set + extend_ttl` |
| `revoke_sbt_delegation` | `instance().remove` → `persistent().remove` |
| `get_delegation` | `instance().get` → `persistent().get` |
| `is_delegate_active` | `instance().get` → `persistent().get` |
| `delegate_sbt_usage` | `instance().set` → `persistent().set + extend_ttl` |
| `verify_delegated_sbt` | `instance().get` → `persistent().get` |
| `burn_sbt` (two variants) | `instance().remove` → `persistent().remove` |
| `batch_burn` | `instance().remove` → `persistent().remove` |
| `batch_transfer` | `instance().remove` → `persistent().remove` |
| `transfer_sbt_with_attestor` | `instance().remove` → `persistent().remove` |
| `transfer_ownership` (two variants) | `instance().remove` → `persistent().remove` |

## Compatibility / Migration

Existing instance-storage delegation entries written by the **old contract version** will
**not** be readable via persistent storage.  However:

- Delegations are time-bounded (`expires_at` field).  Any delegation active before upgrade
  will naturally appear as "not found" after upgrade.  The worst-case result for an active
  delegation is that `is_delegate_active` returns `false` (safe-fail: delegatee loses a
  non-critical usage right temporarily).
- No assets are moved and no credentials are affected by a stale delegation.
- If continuity of active delegations is required, operators should notify delegators to
  re-issue delegations after the upgrade.

A read-fallback that attempts `instance()` before `persistent()` is **not** added because:
1. It would permanently increase instance footprint for every delegation read.
2. The safe-fail behaviour is acceptable per the security model.
3. The contract is still pre-mainnet, so no live delegations currently exist.

## Consequences

- Per-delegation TTL lifecycle now matches every other per-entity record.
- Instance storage footprint no longer grows with the number of delegations.
- Tests (`test_delegation_persists_same_as_token`) confirm the migration.
