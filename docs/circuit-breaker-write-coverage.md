# Circuit Breaker: Degraded-Mode Write Coverage (issue #1393)

`circuit_breaker::enforce_degraded_write_limit` caps the number of writes the
contract accepts per ledger while it is in `Degraded` state. The cap is only
meaningful if every state-mutating entry point routes through it.

## The two guards

| Guard | What it does | Used by |
| --- | --- | --- |
| `require_not_paused` | auto-recovery check → pause check → degraded write cap | entry points that must be blocked entirely while the contract is paused |
| `enforce_write_limit` | auto-recovery check → degraded write cap only | mutating entry points that predate `require_not_paused` and whose pause semantics must not change |

An entry point calls **one** of the two, never both: each call consumes a write
slot, so calling both would charge one logical operation twice.

## Coverage

Every `pub fn` in `contracts/quorum_proof/src/lib.rs` that writes to storage
passes through one of the two guards, except the entry points listed below.
`circuit_breaker::tests::every_mutating_entry_point_is_write_limited` parses
`lib.rs` and fails CI if a new mutating entry point is added without a guard or
an exemption, so this list cannot silently drift.

## Intentional exemptions

**Recovery controls** — `initialize`, `pause`, `unpause`,
`set_circuit_breaker_config`, `migrate_state`.
These are how an operator gets *out* of a degraded or paused contract. Capping
them could make the contract unrecoverable once the cap is exhausted.

**Admin configuration** — `set_rate_limit_config`,
`set_issuer_rate_limit_config`, `add_rate_limit_whitelist`,
`remove_rate_limit_whitelist`, `set_congestion_config`,
`update_congestion_and_adjust`, `admin_bypass_rate_limit`, `set_issuer_quota`,
`remove_issuer_quota`, `set_pow_difficulty`, `set_max_attestors_per_slice`,
`set_grace_period`, `set_reputation_weighting_enabled`,
`set_transfer_restriction`, `set_attestor_reputation_config`,
`set_holder_reputation_config`.
Admin-only, bounded in volume, and the levers operators reach for *while*
responding to the incident that degraded the contract.

**Reached from a guarded path** — `slash_attestor`, `detect_fork`.
Both are also invoked internally from entry points that already consume a write
slot. Guarding them again would charge two slots for one operation.

**Read paths with derived writes** — `get_credential_metadata_schema`,
`get_metadata_schema_distribution`, `validate_contract_state`,
`get_pow_difficulty`, `get_rate_limit_usage`, `get_attestation_window`,
`get_slice_attack_cost_estimate`, `get_slice_modifications`, `is_attested`,
`is_quorum`, `check_quorum_intersection`, `get_proof_request`,
`get_proof_request_audit_log`, `get_attestor_reputation_record`,
`get_holder_reputation`, `verify_credential`, `get_attestation_queue`,
`recommend_attestors`, `validate_slice_composition`,
`bbs_get_revocation_accumulator`.
Their only write is a cache entry or audit line derived from the read itself,
not caller-supplied state growth. Capping them would break monitoring and
verification in Degraded mode without limiting what the cap exists to limit.

## Adding a new entry point

If it writes storage: call `Self::require_not_paused(&env)` when it should also
be blocked while paused, otherwise `Self::enforce_write_limit(&env)`, placed
immediately after the caller's `require_auth()` so unauthenticated calls cannot
burn write slots. If it genuinely belongs in one of the categories above, add
it to `EXEMPT` in the coverage test *and* to this document.
