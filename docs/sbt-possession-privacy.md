# SBT Possession Commitments — Privacy Guarantees

## Problem

SBT ownership is public on-chain: `owner_of(token_id)` and `get_sbt_by_owner(owner)`
on `sbt_registry` let anyone map an address to the SBTs it holds. A holder who
wants to prove *"I possess a valid SBT of this kind"* to a verifier — without
that verifier learning (or being able to look up) the holder's address —
previously had no mechanism to do so.

## Mechanism

`SbtRegistryContract` implements a hash-based possession commitment scheme:

1. `create_sbt_possession_commitment(env, holder, sbt_id) -> Bytes` — the
   holder authorizes this call (`holder.require_auth()`), and the contract
   verifies `holder == owner_of(sbt_id)`. It then derives
   `commitment = sha256(sbt_id_be_bytes || nonce_be_bytes)`, where `nonce` is
   a per-SBT counter (`get_commitment_nonce`) incremented on every call. Only
   `commitment` and `sbt_id` are stored on-chain, in a
   `PossessionCommitmentRecord` keyed by the commitment hash itself.
2. `verify_sbt_commitment(env, commitment, proof) -> bool` — anyone can call
   this. It checks that `commitment` was previously registered and that
   `sha256(proof) == commitment`. It takes no holder address as input and
   returns none.
3. `assert_sbt_commitment(env, commitment, proof)` — same check, panics
   instead of returning `false`, for callers that want a hard failure.

To prove possession, the holder shares `commitment` and `proof` (the
preimage) with a verifier out of band (e.g. over an authenticated but
identity-blind channel). The verifier calls `verify_sbt_commitment` and gets
a yes/no answer.

## What this guarantees

- **The on-chain record carries no holder address.** `PossessionCommitmentRecord`
  has exactly three fields: `sbt_id`, `commitment`, `created_at`. A verifier
  reading `get_possession_commitment` learns which SBT the commitment is
  for and when it was created, never who created it.
- **Only the current owner can mint a valid commitment for an SBT.**
  `create_sbt_possession_commitment` checks `holder == owner_of(sbt_id)`
  before writing anything, so a valid commitment is proof that *some*
  address which was the owner at creation time authorized it.
- **Verification is non-interactive and address-free.** `verify_sbt_commitment`
  takes only `commitment` and `proof`; there is no parameter through which a
  verifier could request or receive the holder's address as part of the
  verification flow itself.
- **Commitments are unlinkable across presentations by hash alone.** Because
  the nonce is a monotonically increasing counter rather than a random value,
  a holder who creates two commitments for the *same* SBT produces two
  different, unlinkable-by-content hashes (`sha256` of different preimages) —
  but see the limitation below regarding on-chain linkability.

## What this does **not** guarantee (limitations)

- **`sbt_id` itself is not hidden.** The commitment is bound to a specific
  `sbt_id`, and `owner_of(sbt_id)` is public. A verifier who is told, or
  infers, which `sbt_id` a commitment corresponds to can still look up its
  current owner on-chain. This scheme hides the *link between a given proof
  presentation and its creator* — it is not a mechanism for hiding token
  ownership itself. Callers who need the latter should not reveal `sbt_id`
  or the commitment on a public channel where an observer can correlate it
  against `get_sbt_by_owner`/`owner_of` results.
- **On-chain linkability of creation events.** `create_sbt_possession_commitment`
  is itself a transaction submitted by (and requiring the signature of) the
  holder's address. Anyone watching the mempool/ledger at creation time can
  see which address created a commitment for which `sbt_id`, even though the
  *stored record* omits the address. Holders who need creation-time
  unlinkability should submit this transaction through a relayer/meta-tx
  path rather than directly from their own address — that is an application-level
  concern outside this contract's scope.
- **Replay of a proof is not prevented.** `verify_sbt_commitment` is a pure
  read of on-chain state; presenting the same `(commitment, proof)` pair
  twice verifies successfully both times. Applications needing single-use
  proofs should layer a nonce or expiry check of their own (e.g. verifier-side
  tracking of consumed commitments) on top of this primitive.
- **This is a commitment scheme, not a zero-knowledge proof.** `proof` is the
  literal preimage (`sbt_id || nonce`), not a ZK witness — anyone who learns
  `proof` for a given `commitment` can re-derive `sbt_id`. It hides the
  *holder*, not the *token identity*, from the verification call itself.

## Threat model summary

| Actor | Can learn from `verify_sbt_commitment` alone | Cannot learn |
|---|---|---|
| Verifier (given commitment + proof) | The SBT was legitimately possessed by its owner at commitment-creation time; the `sbt_id` (via `proof`) | The holder's address |
| Passive chain observer (given only the stored `PossessionCommitmentRecord`) | `sbt_id`, `commitment`, `created_at` | The holder's address, the `proof`/nonce |
| Active chain observer watching the `create_sbt_possession_commitment` call itself | The calling address (standard transaction visibility) | Nothing beyond what direct transaction submission already reveals |
