# `.unwrap()` Audit — `quorum_proof` (issue #1391)

A bare `.unwrap()` aborts the transaction with an opaque host trap rather than
one of the contract's `ContractError` variants. Off-chain clients and indexers
cannot map a host trap back to a cause, and tests cannot assert on it
precisely. This document records the audit of the `.unwrap()` call sites in
`contracts/quorum_proof/src/lib.rs` and the rule applied to new code.

## Classification

Every non-test call site falls into one of three groups.

### Provably safe — bounded index into a collection just measured

The dominant pattern is `for i in 0..items.len() { let x = items.get(i).unwrap(); }`.
The index is derived from the same `Vec`'s length in the same call, so `get`
cannot return `None`. Batch entry points that index *parallel* vectors
(`issue_credentials_batch`, `verify_claims_batch`, `verify_credentials_batch`,
`batch_verify_with_expiry`, …) assert that all input vectors have equal length
before the loop, so the parallel indexing is equally bounded. Left as-is.

### Provably safe — existence checked immediately before

`if env.storage().instance().has(&key) { ... .get(&key).unwrap() }`. Soroban
contract execution is single-threaded within a transaction, so nothing can
remove the entry between the check and the read. These were still converted
where the surrounding function already had a natural error variant, because the
conversion costs nothing and makes a future refactor that drops the `has` check
fail loudly and typed.

### Reachable / non-obvious — converted to typed errors

| Call site | Previous failure | Now |
| --- | --- | --- |
| `issue_credential`, `issue_inner` — credential type definition lookup | host trap | `ContractError::CredentialTypeNotFound` |
| `get_credentials_by_type` — credential lookup during the id scan | host trap | `ContractError::CredentialNotFound` |
| `update_attestor_weight` — attestor weight lookup | host trap | `ContractError::NotInSlice` |
| `replace_attestor` — old attestor weight lookup | host trap | `ContractError::NotInSlice` |
| `validate_slice_composition` — composition rule read | host trap | restructured to `match`, no unwrap |

The two weight lookups are the only ones where the invariant is not local: they
index `slice.weights` with a position found in `slice.attestors`, which relies
on the two vectors staying the same length across every slice mutation path. A
typed `NotInSlice` is the right signal if that invariant is ever broken.

## Rule for new code

In contract code, prefer:

```rust
.unwrap_or_else(|| panic_with_error!(&env, ContractError::SomeVariant))
```

`scripts/check_unwraps.sh` enforces this as a ratchet in CI: it counts bare
`.unwrap()` calls in non-test contract source and fails if the count grows.
When occurrences are removed, lower `BASELINE` in that script to lock the
improvement in.
