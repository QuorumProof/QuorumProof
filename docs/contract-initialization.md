# Contract Initialization

Each QuorumProof contract is initialized once, after deployment, to record its
admin. `sbt_registry` also records the `quorum_proof` address it is bound to.
This document describes what each `initialize` entry point guarantees (issues
#1722 and #1723).

## One-time initialization

Every contract stores its admin in instance storage on the first successful
`initialize` call. A second call always panics with `already initialized` and
leaves stored state untouched.

| Contract | `initialize` signature | Guard against re-init | Requires admin auth |
|---|---|---|---|
| `quorum_proof` | `initialize(admin)` | Yes | Yes (#1723) |
| `sbt_registry` | `initialize(admin, quorum_proof_id)` | Yes (#1722) | Yes |
| `zk_verifier` | `initialize(admin)` | Yes | **No** (see below) |

### `sbt_registry` (issue #1722)

Before #1722, `sbt_registry::initialize` required admin auth but did not check
whether it had already run. Any address that could sign as the admin's
replacement could call it again, overwrite `DataKey::Admin`, and rebind
`DataKey::QuorumProofId` to its own values. The function now asserts that no
admin is stored before it does anything else.

Guarantee: after the first successful call, the admin and the
`quorum_proof` binding can only change through the governance entry points
(`update_admin`, `update_quorum_proof_id`), which require the current admin's
authorization.

Test coverage: `test_initialize_twice_is_rejected_and_keeps_admin_and_binding`
in `contracts/sbt_registry/src/lib.rs`.

### `quorum_proof` (issue #1723)

`quorum_proof::initialize` now calls `admin.require_auth()`. Before this, the
admin address could be set to any value by any caller, because the admin never
had to sign. The admin must now authorize the call, so the stored admin is
always an address that controls its key.

Test coverage: `test_initialize_rejects_unsigned_admin` in
`contracts/quorum_proof/src/lib.rs`.

### `zk_verifier`

`zk_verifier::initialize` has the one-time guard but does not call
`admin.require_auth()`, so the admin address can still be set by a caller that
does not control it. Until that is added, initialize `zk_verifier` from a
transaction signed by the admin key.

## Deploying and initializing

Sign each `initialize` call with the admin key, not the deployer key. The
admin key must match the `--admin` argument. The exact commands are in
[deployment-guide.md](./deployment-guide.md#41-initialize-contracts).

Initialize in this order, because `sbt_registry` needs the `quorum_proof`
address:

1. `quorum_proof.initialize(admin)`
2. `sbt_registry.initialize(admin, quorum_proof_id)`
3. `zk_verifier.initialize(admin)`

Check that each call succeeded, then confirm the stored values:

```bash
stellar contract invoke --id $CONTRACT_SBT_REGISTRY --source admin --network mainnet \
  -- get_quorum_proof_id
```

A second `initialize` on any contract should fail. If it succeeds, stop and
investigate before continuing.
