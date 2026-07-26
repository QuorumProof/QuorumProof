# Performance Regression Testing

## Overview

QuorumProof's performance-critical code is the Soroban smart contracts
(`contracts/quorum_proof`, `contracts/sbt_registry`, `contracts/zk_verifier`).
For a smart contract, "performance" means **on-chain resource consumption**
(CPU instructions and memory bytes, metered deterministically by
`soroban-sdk`'s budget system) rather than wall-clock time — wall-clock
benchmarking (e.g. the `criterion` crate) measures something contracts don't
actually pay for on-chain, and would not catch a regression that costs real
gas while running fast on a benchmarking machine. This is why the project's
performance regression suite (`benches/`) is built directly on
`env.budget()` instead of `criterion`: it measures the same units the chain
itself enforces.

This document describes the existing baseline/regression system, how to run
and extend it, and where its coverage currently stops.

## What Is Measured

`benches/tests/benchmarks.rs` measures CPU instructions and memory bytes for:

- `issue_credential`, `create_slice`, `attest`, `revoke_credential`
- `mint_sbt`, `burn_sbt` (sbt_registry)
- `verify_claim`, `verify_plonk_proof`, `verify_aggregate_proof` (zk_verifier)
- `verify_engineer` (full cross-contract QuorumProof → SbtRegistry → ZkVerifier path)
- `batch_issue_credentials`, `verify_attestations_batch` (batch operations)

Each measurement resets the budget (`env.budget().reset_default()`), runs
the operation once, and reads `cpu_instruction_cost()` /
`memory_bytes_cost()` — see the `measure()` helper near the top of
`benches/tests/benchmarks.rs`.

## Regression Thresholds (Fixed Gate)

Every operation above has a `const THRESHOLD_*_CPU` / `THRESHOLD_*_MEM` in
`benches/tests/benchmarks.rs`, set at **measured baseline × 1.10** (a strict
10% regression budget). A test `assert!`s that the measured cost stays at or
under its threshold; if not, the test fails.

**Raise a threshold only with a written justification in the PR** — a
threshold bump silently hides a regression from every future run.

Run the fixed-threshold suite:

```bash
cargo test -p quorum-proof-benches --test benchmarks -- --nocapture
```

`scripts/benchmark_compare.sh` wraps this and extracts the printed
`cpu=... mem=...` lines into `benchmark-results.json` for comparison against
a stored baseline file. `scripts/profile_contracts.sh` runs the same suite
and produces a Markdown hotspot report (`target/profile_report.md`),
flagging any operation using >80% of its threshold even though it hasn't
failed yet.

## Scaling / Complexity-Class Gate (Trend Detection)

The fixed-threshold gate above catches a single run's absolute cost, but not
a *shape* regression that creeps in gradually (e.g. an O(n) loop becoming
O(n²) while staying under threshold at today's n). `bench_*_scaling` tests
in the same file run an operation across a range of `n` (capped at the
contract's own limits — `MAX_ATTESTORS_PER_SLICE` = 20,
`MAX_BATCH_SIZE` = 50 — since no real call can exceed those) and record each
`(n, cpu, mem)` point via `quorum_proof_benches::scaling::record_point`.

`benches/src/bin/scaling_report.rs` then:

1. Fits `cost ≈ a·n^b` by OLS log-log regression per operation
   (`benches/src/complexity.rs`) and classifies the exponent `b` as
   `LinearOrBetter` (b < 1.2), `Superlinear` (1.2 ≤ b < 1.8, flagged but not
   gate-failing), or `QuadraticOrWorse` (b ≥ 1.8, **fails the gate**).
2. Appends the fit to `benches/history/<op>.jsonl` (`benches/src/history.rs`)
   — one line per CI run, committed to the repo so history is diffable via
   normal `git log` rather than living only in CI artifact retention — and
   compares the new exponent against the prior entry to surface drift even
   when the current run alone doesn't fail.
3. Renders `benches/target/bench-scaling-report.md`.

Run both steps together:

```bash
./scripts/scaling_benchmark_report.sh
```

### CI Wiring

`.github/workflows/benchmarks.yml` runs `scripts/scaling_benchmark_report.sh`
on every PR/push touching `contracts/**` or `benches/**`, uploads the
report and raw data as a build artifact, and **fails the job** if the
complexity gate reports a failure.

Note: `benches` is intentionally excluded from the root Cargo workspace
(`Cargo.toml`'s `exclude = [...]`), so the main `ci.yml`'s
`cargo test --workspace` does **not** run these benchmarks — coverage comes
entirely from the dedicated `benchmarks.yml` workflow above. Keep this in
mind if `benches/Cargo.toml` or its dependency versions ever drift from the
root workspace's `soroban-sdk` version; there's no single `cargo test` run
that would catch a mismatch.

## Historical Baselines

Recorded 2025-05, `soroban-sdk` 21.x testutils (see the header comment in
`benches/tests/benchmarks.rs` for the authoritative, currently-maintained
copy):

| Operation | CPU (baseline) | Memory (baseline) |
|---|---|---|
| `issue_credential` | ~1,500,000 | ~1,500,000 |
| `create_slice` | ~1,500,000 | ~1,500,000 |
| `attest` | ~1,500,000 | ~1,500,000 |
| `revoke_credential` | ~1,100,000 | ~1,100,000 |
| `mint_sbt` | ~2,600,000 | ~2,600,000 |
| `burn_sbt` | ~1,500,000 | ~1,500,000 |
| `verify_claim` | ~1,100,000 | ~1,100,000 |
| `verify_engineer` (cross-contract) | ~4,000,000 | ~4,000,000 |
| `batch_issue` (5) | ~9,000,000 | ~9,000,000 |
| `batch_verify` (5) | ~3,000,000 | ~3,000,000 |

Each CI-enforced threshold in `benches/tests/benchmarks.rs` is this baseline
× 1.10.

## Large-Scale / High-Volume Coverage

The scaling tests above already exercise the full range reachable through
the public contract API for batch operations (`n` up to `MAX_BATCH_SIZE`,
i.e. 50 — a real transaction cannot request a larger batch, so testing
beyond that measures something no caller can trigger).

`benches/load_test_batch_operations.rs` is a separate file intended to
stress-test **1000+ sequential credential issuances** (i.e. cumulative
system-wide volume, not a single oversized batch call) using
`libfuzzer-sys`/`arbitrary`. **This file is currently unwired**: it is not
declared as a `[[bin]]` target in `benches/Cargo.toml` (which has neither
`libfuzzer-sys` nor `arbitrary` as a dependency), nor in `fuzz/Cargo.toml`'s
`[[bin]]` list alongside the other fuzz targets in `fuzz/fuzz_targets/`. As
written, it cannot currently be built or run — recorded here rather than
silently left to look like working coverage. Wiring it up (moving it under
`fuzz/fuzz_targets/` and adding a matching `[[bin]]` entry, or converting it
to a `benches/tests/`-style integration test against a loop of 1000+
`issue_credential` calls) is tracked as follow-up scope, not included in
this documentation pass.

## Adding a New Benchmark

1. Add a `#[test] fn bench_<operation>()` to `benches/tests/benchmarks.rs`
   following the existing pattern: `measure(&env, || { ... })`, print
   `cpu=... mem=...`, `assert!` against a new `THRESHOLD_*` constant set to
   the measured baseline × 1.10.
2. If the operation takes an `n`-sized input, add a matching
   `bench_<operation>_scaling` test capped at the relevant contract-enforced
   maximum, calling `scaling::record_point`.
3. Run `./scripts/scaling_benchmark_report.sh` locally to confirm the new
   operation gets a clean complexity-class fit before opening a PR.
