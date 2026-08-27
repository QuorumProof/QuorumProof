# Batch Issuance Limits

Guidance for API-server callers of the batch-issuance entry points
(`batch_issue_credentials`, `issue_batch`, `issue_batch_by_did`,
`batch_issue_credentials_by_did`) so calls are sized to succeed on-chain
instead of reverting.

## Hard contract-enforced ceiling

Every batch-issuance entry point validates the batch length against
`MAX_BATCH_SIZE` (50, `contracts/quorum_proof/src/lib.rs`) before doing any
issuance work:

```rust
Self::validate_array_bounds(batch_len, 1, MAX_BATCH_SIZE, "...");
```

**A batch of more than 50 items always reverts**, regardless of Soroban
resource limits — this is a contract-level assertion, not a budget failure.
Callers must chunk any batch larger than 50 into multiple transactions.

## Practical safe batch size

`benches/tests/benchmarks.rs::bench_batch_issue_credentials_by_did_scaling`
measures `batch_issue_credentials_by_did` at batch sizes 1, 10, and 50 with a
slice already present in contract state at `MAX_ATTESTORS_PER_SLICE` (20
attestors, admin-adjustable via `set_max_attestors_per_slice`) — the
realistic worst case for a heavily-attested deployment. Batch size 100 is
included in the sweep purely to demonstrate the `MAX_BATCH_SIZE` revert
described above.

Run the sweep and compare CPU/memory against Soroban's per-transaction
resource limits with:

```sh
cargo test --manifest-path benches/Cargo.toml --test benchmarks \
  bench_batch_issue_credentials_by_did_scaling -- --nocapture
```

Recorded points also feed `benches/src/bin/scaling_report.rs`
(`scripts/scaling_benchmark_report.sh`), which fits a complexity curve
across the sweep and fails CI (`.github/workflows/benchmarks.yml`) if
`batch_issue_credentials_by_did`'s cost stops scaling linearly with batch
size — a superlinear regression here is the leading indicator that a
batch well under the hard cap of 50 could still blow the transaction budget.

As a starting point until per-network resource limits are pulled into the
gate automatically: keep batches at or below **50** (the hard ceiling) and
treat any CI report showing superlinear growth as a signal to lower that
recommendation before it's exercised in production.
