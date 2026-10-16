# Fuzz testing

Issue #1487. QuorumProof uses [cargo-fuzz](https://rust-fuzz.github.io/book/cargo-fuzz.html)
(libFuzzer) to fuzz the core cryptographic and credential-handling paths.
A broader guide to the fuzz suite — including corpus management and reproducing
historical findings — is at [`docs/fuzz-testing-guide.md`](../docs/fuzz-testing-guide.md).

## Fuzz targets

| Target | What it exercises |
| --- | --- |
| `fuzz_verification_functions` | Groth16 / PLONK proof parsing and verification entry points |
| `fuzz_bbs_plus_operations` | BBS+ selective-disclosure sign / verify / derive paths |
| `fuzz_zk_verifier` | ZK verifier contract dispatch and public-input parsing |
| `fuzz_credential_issuance` | Credential issuance, metadata hashing, and revocation |
| `fuzz_batch_operations` | Batch-verify and batch-issue paths |

## CI pass/fail semantics

### PR / push jobs (`fuzz` workflow job)

The 30-second fuzz run on pull requests and pushes to `main`/`develop`
**fails the build** if any crash, timeout, or sanitiser violation is detected.
`continue-on-error` is intentionally absent — a newly discovered crash in any
of the five targets will block the PR so it is triaged before merging.

Crash artifacts (the reproducing input) are uploaded as a GitHub Actions
artifact (`fuzz-crashes-<target>`) on failure.

### Nightly jobs (`fuzz-nightly` workflow job)

The extended 5-minute nightly run (scheduled at 02:00 UTC) also **fails the
job** on crash, but because it is triggered by `schedule` (not by a PR), it
does not block any merge. Instead, on failure it:

1. Uploads crash artifacts to the Actions run.
2. Opens a GitHub issue labeled `bug`, `security`, and `fuzz-crash` with a
   direct link to the run and reproduction instructions.

This ensures nightly findings are immediately visible in the issue tracker
rather than requiring someone to manually check the Actions tab.

## Running locally

```bash
# One-off 30-second run (same as CI)
cd fuzz
cargo +nightly fuzz run fuzz_verification_functions -- -max_total_time=30

# Extended run (no time limit — Ctrl-C to stop)
cargo +nightly fuzz run fuzz_bbs_plus_operations

# Reproduce a crash from a saved input file
cargo +nightly fuzz run fuzz_zk_verifier path/to/crash-input
```

Crash inputs are written to `fuzz/artifacts/<target>/` automatically by
libFuzzer.  Commit any non-trivial reproducer to `fuzz/corpus/<target>/` so
it is exercised on all future runs.

## Adding a new target

1. Add a new file in `fuzz/fuzz_targets/`.
2. Register it in `fuzz/Cargo.toml`.
3. Add the target name to the `matrix.fuzz_target` lists in
   `.github/workflows/fuzz.yml` (both the `fuzz` and `fuzz-nightly` jobs).
