# QuorumProof Contract — Module Index

Maps each source file under [`src/`](src/) to its purpose and the GitHub
issue or task that motivated it, so a new contributor doesn't have to open
every file to build that map themselves.

New feature modules should add themselves to this table when they land.

| File | Purpose | Issue / Task | ADR |
|---|---|---|---|
| [`lib.rs`](src/lib.rs) | Contract entry points, core types (credentials, slices, attestations), quorum-slice trust model | — | [ADR-001](../../docs/adr/adr-001-fba-trust-model.md), [ADR-006](../../docs/adr/adr-006-quorum-intersection-verification.md) |
| [`rbac.rs`](src/rbac.rs) | Role-based access control (Admin/Issuer/Verifier/RevocationAgent/Auditor), role delegation and audit log | — | — |
| [`key_escrow.rs`](src/key_escrow.rs) | BBS+ issuer key escrow/backup: threshold guardian shares, recovery submission, recovery cancellation | Task #1295 | [ADR-007](../../docs/adr/adr-007-bbs-plus-selective-disclosure.md) |
| [`attestation_veto.rs`](src/attestation_veto.rs) | Time-locked veto of attestations by designated authorities | Issue #910 | — |
| [`atomic_operations.rs`](src/atomic_operations.rs) | Transactional semantics for multi-step operations across contracts | Issue #913 | — |
| [`migration_v2.rs`](src/migration_v2.rs) | `migrate_to_v2()` contract version migration path with data transformation/validation | Issue #915 | — |
| [`migration.rs`](src/migration.rs) | Generic paginated/chunked migration engine (works around per-invocation CPU/memory limits) | — | — |
| [`slice_enhancements.rs`](src/slice_enhancements.rs) | Threshold signature verification and performance metrics tracking for quorum slices | Issue #1235, #1236 | — |
| [`time_lock_attestation.rs`](src/time_lock_attestation.rs) | Time-locked credential approval window before an attestation takes effect | Issue #872 | — |
| [`upgrade_history.rs`](src/upgrade_history.rs) | Records contract upgrade history (WASM hash, timestamp, initiator) | Issue #874 | — |
| [`upgrade_schedule.rs`](src/upgrade_schedule.rs) | Scheduled (delayed) contract upgrades instead of immediate application | — | — |
| [`formal_verification_invariants.rs`](src/formal_verification_invariants.rs) | Runtime invariant checks mirroring the contract's formal safety properties | Issue #1317 | — |
| [`state_metrics.rs`](src/state_metrics.rs) | Operator-facing contract health metrics | — | — |
| [`state_validation.rs`](src/state_validation.rs) | State validation result types used by `validate_contract_state` | — | — |
| [`circuit_breaker.rs`](src/circuit_breaker.rs) | Circuit-breaker guard for pausing risky operations under abnormal conditions | — | — |
| [`version.rs`](src/version.rs) | Semantic versioning helpers for contract upgrades | — | — |
| [`bbs_plus_features.rs`](src/bbs_plus_features.rs) | BBS+ selective disclosure feature implementations | Issues #1287, #1288, #1289, #1290 | [ADR-007](../../docs/adr/adr-007-bbs-plus-selective-disclosure.md) |

Test-only modules (`*_tests.rs`, `proptest_*.rs`, `tests_new_*.rs`, `fuzz_tests.rs`)
are omitted from this table; their own doc comments reference the issue(s)
they cover.
