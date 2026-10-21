# Test Data Factories

The API server test suite builds credentials, quorum slices, and soulbound
tokens (SBTs) through factories in `api-server/tests/factories/` (issue #1677).
Factories replace hand-written fixture objects, so a test states only the
fields it cares about and gets valid, consistent data for the rest.

---

## Quick start

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildCredential,
  buildSlice,
  buildSbt,
  resetFactorySequences,
} from './factories/index.js';

beforeEach(() => resetFactorySequences());

it('flags a revoked credential', () => {
  const credential = buildCredential({ revoked: true });
  // ...exercise the code under test with `credential`
});
```

---

## Available factories

| Factory | Builds | Matches | Batch helper |
|---|---|---|---|
| `buildCredential(overrides?)` | `CredentialFixture` | `Credential` in `contracts/quorum_proof/src/lib.rs` | `buildCredentials(n, overrides?)` |
| `buildSlice(overrides?)` | `SliceFixture` | `QuorumSlice` in `contracts/quorum_proof/src/lib.rs` | `buildSlices(n, overrides?)` |
| `buildSbt(overrides?)` | `SbtFixture` | `SoulboundToken` in `contracts/sbt_registry/src/lib.rs` | `buildSbts(n, overrides?)` |
| `stellarAddressFor(i)` | valid `G...` address | StrKey ed25519 public key | — |
| `resetFactorySequences()` | — | resets every id and address counter | — |

Every factory returns a plain JSON-shaped object. Enum fields use the
contract's numeric discriminants. `CREDENTIAL_STATUS` and `RENEWAL_STATUS`
export those values so tests do not hard-code magic numbers.

### Defaults

- **Credential:** active, not revoked or suspended, no expiry, version 1,
  requires one attestation.
- **Slice:** three attestors with weight 1 each and threshold 2 (a 2-of-3
  quorum), reputation weighting off.
- **SBT:** version 1, no upgrade, no co-owner.

### Overrides

Pass a partial object. Only the given fields change:

```ts
const joint = buildSbt({ owner: someAddress, co_owner: otherAddress });
const expired = buildCredential({ expires_at: 1_600_000_000 });
const solo = buildSlice({ attestors: [a], weights: [1], threshold: 1 });
```

---

## Invariants

Factories throw at build time when an override would produce a fixture the
contract could never accept. This catches broken tests early.

| Factory | Rejected input |
|---|---|
| Credential | `required_attestations < 1`, `version < 1` |
| Slice | no attestors, weights and attestors of different length, negative or non-integer weights, `threshold` outside `1..=total weight` |
| SBT | `version < 1`, `co_owner` equal to `owner`, `upgraded_to` equal to its own id |

Use `assertSliceInvariants(slice)` to check a slice you assembled by hand.

To test what the code does with *invalid* data, construct the object literal
directly. The factories are for valid fixtures only.

---

## Determinism and uniqueness

- Ids come from a per-factory counter. Two credentials built in one test never
  share an id.
- Stellar addresses are derived from a counter, so they are valid `G...` keys
  and the same sequence yields the same addresses.
- Call `resetFactorySequences()` in `beforeEach` when a test asserts on a
  specific id or address. Without the reset, ids depend on test execution
  order.

---

## Adding a factory

1. Add `tests/factories/<name>.ts` exporting a `build<Name>(overrides)`
   function, a batch helper, and a `reset<Name>Sequence()` function.
2. Mirror the contract struct's field names. If the struct changes, update the
   factory in the same change.
3. Enforce the invariants the contract relies on, and throw on violation.
4. Re-export it from `tests/factories/index.ts` and add it to
   `resetFactorySequences()`.
5. Add cases to `tests/factories.test.ts` for defaults, overrides, uniqueness,
   and each invariant.

---

## Tests

```bash
cd api-server
npx vitest --run tests/factories.test.ts
```

The factory tests run as part of `npm test`.
