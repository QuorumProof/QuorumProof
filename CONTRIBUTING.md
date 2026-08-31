# Contributing to QuorumProof

Thank you for contributing to QuorumProof!  This guide covers the
conventions we use so that the codebase stays maintainable and every past
incident has discoverable regression coverage.

---

## Regression Test Convention (Issue #1479)

Whenever a bug is fixed, a regression test **must** be added so the bug
cannot silently return.

### Where to put regression tests

| What regressed | Where the test goes |
|---|---|
| Contract logic in `contracts/quorum_proof` | `contracts/integration_tests/src/regressions.rs` (preferred) or a `#[cfg(test)]` block in the relevant source file |
| API-server behaviour | `api-server/tests/` alongside existing tests |
| Anything else | Nearest `*_tests.rs` or `tests/` directory, with a clear `// regression: #N` comment |

### How to write a regression test

1. **Name the test after the bug.**  Prefix with `regression_<issue_number>_`:

   ```rust
   #[test]
   fn regression_1362_attestor_may_attest_once_per_slice() { … }
   ```

2. **Pin the test to the issue with a comment on the `#[test]` attribute:**

   ```rust
   // regression: #1362
   #[test]
   fn regression_1362_attestor_may_attest_once_per_slice() { … }
   ```

3. **Describe the bug in the function doc-comment.**  Include:
   - What the bug was.
   - How the fix changed the code (briefly).
   - Why removing the fix would make *this specific test* fail.

4. **Add the test to `contracts/integration_tests/src/regressions.rs`** under
   a named submodule `regression_<issue_number>`.  The module comment
   must include the issue title.

5. **Verify the test is red without the fix.**  Temporarily revert the fix
   locally and confirm the test fails before submitting your PR.

### Minimal example

```rust
// contracts/integration_tests/src/regressions.rs

mod regression_1362 {
    // regression: #1362 — enforce quorum intersection safety checks in
    // attestation flow.
    use quorum_proof::{QuorumProofContract, QuorumProofContractClient};
    use soroban_sdk::{testutils::Address as _, vec, Address, Bytes, Env};

    fn setup(env: &Env) -> QuorumProofContractClient<'_> {
        env.mock_all_auths();
        let id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &id);
        client.initialize(&Address::generate(env));
        client
    }

    // regression: #1362
    /// An attestor who belongs to two *different* slices must be able to
    /// attest for the same credential in each slice independently.
    /// Before the fix this panicked because the duplicate guard was keyed
    /// globally per (credential, attestor) instead of per
    /// (credential, slice, attestor).
    #[test]
    fn regression_1362_attestor_may_attest_once_per_slice() {
        // … test body …
    }
}
```

### Existing regressions

The current regression inventory lives in
`contracts/integration_tests/src/regressions.rs`.  Each module in that
file corresponds to one closed issue.

| Issue | Module | Description |
|---|---|---|
| #1362 | `regression_1362` | Per-(credential,slice) attestation duplicate guard; `check_quorum_intersection` validates safe_nodes across all slices |

---

## General Guidelines

- Fork the repository and work on a feature branch.
- Run `cargo test --target x86_64-unknown-linux-gnu --workspace` before
  opening a PR.
- Keep PR titles under 70 characters; use the description for details.
- Open a GitHub issue before starting non-trivial work so effort isn't
  duplicated.

## Code Style

- Follow the Rust API guidelines.
- Keep `#[contracttype]` structs in `lib.rs`; business logic in separate
  modules under `src/`.
- All public contract entry points must have a doc-comment explaining
  parameters, panics, and side effects.

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy.
Do not open public issues for security vulnerabilities.
