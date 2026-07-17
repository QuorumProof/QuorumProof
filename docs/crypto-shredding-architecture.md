# Crypto-Shredding Architecture

## Status

Accepted — implemented in `api-server/src/services/cryptoShredding.ts`,
`api-server/src/services/durableLog.ts`, and wired into
`api-server/src/routes/gdpr.ts`.

## Problem

[ADR-002](adr/adr-002-sbt-non-transferability.md) establishes that QuorumProof
credentials live on an immutable ledger by design: the SBT contract has no
`transfer()` and, more fundamentally, Soroban/Stellar ledger history cannot be
rewritten. GDPR Article 17 ("right to erasure") nonetheless requires that a
data subject be able to have their personal data made permanently
inaccessible on request.

These two requirements are irreconcilable if "personal data" is interpreted
as "data stored on-chain." They are reconcilable once the system is designed
so that:

1. Personal data never lives on-chain in the first place — only a
   content-addressed commitment to it does.
2. Personal data lives off-chain, encrypted, such that erasure is defined as
   destroying the means of decryption rather than deleting bytes.

This is **crypto-shredding**: instead of promising "the bytes are gone" (a
promise the ledger cannot keep, and that ordinary filesystem deletion cannot
fully keep either), the system promises "the bytes are permanently
unintelligible," by making sure the only key that could ever decrypt them no
longer exists anywhere.

## On-chain vs. off-chain split

This split already exists structurally in the QuorumProof contract: credentials
carry a `metadata_hash: Bytes` field (`contracts/quorum_proof/src/lib.rs`),
not the metadata itself. What was missing was the off-chain half — anything
that actually stored personal data, encrypted or not, and a real mechanism to
render it inaccessible. That is what this document and its implementation
add.

| | On-chain (Soroban ledger) | Off-chain (`PersonalDataVault`) |
|---|---|---|
| Contents | `metadata_hash` — a sha256 commitment | Ciphertext of the actual personal data |
| Mutability | Append-only, immutable | Ciphertext keyed by credential; DEK is separately keyed and independently destructible |
| Survives erasure | Yes — the hash remains forever, as evidence of what *was* attested to, without revealing it | Ciphertext bytes may remain on disk; they become permanently unintelligible |

The commitment is computed with the same primitive the ledger already
expects (`sha256` over the plaintext), so an issuer can pass
`PersonalDataVault#store()`'s returned `commitment` directly as the
`metadata_hash` argument to `issue_credential`. This means credential
integrity stays verifiable — anyone can recompute the hash of a still-decryptable
record and compare it to on-chain state — while the ledger itself never
carries anything erasure could need to touch.

## Key management

- **Granularity**: one Data Encryption Key (DEK) per credential ID. A GDPR
  erasure request in this system is scoped to a single credential (matching
  the existing `/api/gdpr/request` API, which takes a `credentialId`), so key
  granularity matches request granularity. A subject with multiple
  credentials who wants all of them erased submits one request per
  credential.
- **Algorithm**: AES-256-GCM. The DEK is 32 random bytes
  (`crypto.randomBytes(32)`), generated on first write for a given credential
  and reused for subsequent updates to the same credential's data.
- **Storage**: the DEK is held in its own durable append-only log
  (`keys.jsonl`), physically separate from the ciphertext log
  (`ciphertext.jsonl`). There is no master key, no KMS-wrapped envelope, and
  no backup copy of a DEK anywhere else in the system — the DEK *is* the
  root of trust for that credential's personal data, by design, so that
  destroying the one copy is sufficient for erasure.

## Erasure mechanism

Erasure (`PersonalDataVault#eraseKey`) does the following, in order:

1. Checks whether the credential's key has already been erased (idempotent —
   re-erasing returns `alreadyErased: true` rather than erroring).
2. Calls `DurableLog#shred(credentialId)` on the key log, which:
   - Removes the key from the in-memory map.
   - Overwrites the **entire on-disk key log file** with zero bytes before
     rewriting it, so no byte range of the file that used to hold this (or
     any other) DEK survives the operation unmodified.
   - Recompacts the file to contain only the DEKs for credentials that have
     *not* been erased.
3. Durably records an erasure tombstone (`{ erasedAt }`) in a third log
   (`erasures.jsonl`), keyed by credential ID. This tombstone is what makes
   `isErased()` — and therefore the "no, you cannot have this back" answer —
   itself durable and independent of whether the key log still exists.

After this, `PersonalDataVault#retrieve(credentialId)` unconditionally throws
`KeyDestroyedError`. There is no code path — not an admin override, not a
recovery key, not a support tool — that can produce a valid AES-256-GCM key
for that credential ID again. The only way to obtain plaintext again is for
the subject to submit new personal data under a new key.

### What "unrecoverable" means precisely here

- The ciphertext (ideally, deliberately) is **not** deleted. It typically
  stays on disk as an audit artifact: proof that data was once stored and
  then genuinely rendered unreadable, plus its commitment hash for
  cross-referencing against on-chain state.
- Without the DEK, AES-256-GCM ciphertext is computationally infeasible to
  decrypt (this is the standard cryptographic assumption underlying
  crypto-shredding as a GDPR-erasure technique, e.g. as used by cloud KMS
  "schedule key deletion" features).
- This implementation's guarantee is scoped to **application-level
  unrecoverability**: `shred()` overwrites the *current* file with zeros
  before rewriting it. It does not attempt to defeat filesystem-level or
  storage-level copy-on-write, journaling, snapshotting, or backup systems
  that may have captured earlier versions of the key log file outside the
  application's control. Deployments that need a stronger physical guarantee
  should back the key log with storage that supports genuine secure erase
  (e.g. an HSM-backed KMS with key-deletion primitives) rather than a plain
  filesystem — the `PersonalDataVault` interface (`store` / `retrieve` /
  `eraseKey` / `status`) is designed so that swap is possible without
  changing any caller.

## What remains verifiable vs. what becomes inaccessible post-erasure

This is the precise contract callers (and auditors, and data subjects) can
rely on after `eraseKey(credentialId)` has run:

**Remains verifiable / accessible forever:**
- That a GDPR request for this credential was made, when, and by the resolved
  flow (`GdprRequestStore` — durable, never erased).
- Which attestors consented, and when (`attestorConsents[].consentedAt`) —
  the consent records themselves are not personal data about the credential
  subject and are retained for audit.
- That personal data *was* stored for this credential, and when
  (`PersonalDataVault#status().hasData`, `.storedAt`, `.updatedAt`).
- The commitment hash of the erased data (`PersonalDataVault#status().commitment`)
  — sufficient to prove "this specific plaintext was once attested to" if a
  copy is ever produced independently (e.g. in a legal dispute), without the
  vault itself ever revealing it.
- That erasure occurred, and precisely when
  (`PersonalDataVault#status().erased`, `.erasedAt`).
- The on-chain `metadata_hash` for the credential, unchanged, forever (ledger
  immutability — this was always true and is unaffected by this design).

**Becomes permanently inaccessible:**
- The plaintext personal data itself. `PersonalDataVault#retrieve()` throws
  `KeyDestroyedError` for this credential ID, permanently, including after a
  process restart (the erasure tombstone is durable) and including for a
  freshly constructed `PersonalDataVault` pointed at the same data directory.
- The DEK. It cannot be reconstructed from the ciphertext, the commitment
  hash, or any other durably stored value in this system.

## Durability across restarts

Three independent `DurableLog` instances back the vault
(`ciphertext.jsonl`, `keys.jsonl`, `erasures.jsonl`), plus one for GDPR
request state (`requests.jsonl`, via `GdprRequestStore`). Each is an
append-only JSONL write-ahead log: every `set`/`delete`/`shred` call appends
a line and `fsync`s before returning, and a fresh instance replays the whole
file on construction to rebuild its in-memory map (tolerating a torn last
line from a crash mid-append). This means:

- A GDPR request's status, consents, and outcome survive an API server
  restart.
- An erasure tombstone survives a restart — erased stays erased.
- Request IDs (`gdpr_<n>`) remain monotonically increasing across restarts;
  `GdprRequestStore` recovers its counter from the highest ID present in the
  log on load.

Data directories default to `./.data/gdpr-vault` and `./.data/gdpr-requests`
under the process's working directory, and are configurable via
`GDPR_VAULT_DATA_DIR` and `GDPR_REQUEST_STORE_DATA_DIR` respectively —
following the same environment-variable convention as
`SHARD_STORE_DATA_DIR` in `services/shardedStorage.ts`.

## Attestor consent: real signatures, not a raw address count

Prior to this design, `/api/gdpr/consent` counted unique attestor address
*strings* submitted in a request body, with no verification that:

- the address actually belonged to a current attestor for the credential
  (`get_attestors` was only ever consulted once, at request-creation time,
  to compute a *count* — never to check *membership* of a consenting
  address), or
- the party submitting the address had any cryptographic relationship to it
  at all.

This meant any caller who knew (or guessed) enough distinct-looking strings
could complete an erasure. The fix (`services/attestorConsent.ts`):

1. Each consent submission must include a hex-encoded ed25519 signature over
   a canonical message binding the request ID, credential ID, and the
   signer's own address:
   `QuorumProof GDPR Erasure Consent\nrequestId:<id>\ncredentialId:<id>\nattestor:<address>`.
2. The server re-fetches `get_attestors` for the credential **at consent
   time** (not reusing the snapshot from request creation) and rejects any
   `attestorAddress` that is not currently a member.
3. The signature is verified with `Keypair.fromPublicKey(attestorAddress).verify(...)`
   from `@stellar/stellar-sdk` — the same ed25519 primitive Stellar accounts
   already use, so an attestor's existing Stellar keypair is sufficient; no
   new key material needs to be provisioned.

Binding the message to both `requestId` and `credentialId` prevents a
signature collected for one erasure request from being replayed against a
different request or a different credential.

## Known limitations / future work

- Key granularity is per-credential, not per-subject. A subject with `N`
  credentials must submit `N` erasure requests. A subject-level "erase
  everything" endpoint could fan out to each credential's key, but is not
  implemented here — it wasn't part of the existing GDPR API surface this
  change builds on.
- `GET /api/gdpr/personal-data/:credentialId` (plaintext retrieval) has no
  authorization check in this implementation. Production deployments must
  gate it the same way `routes/consent.ts` gates verifier access, before
  this route is exposed publicly.
- `shred()`'s zero-overwrite is a best-effort, application-level guarantee
  (see "What unrecoverable means precisely" above) — it is not a substitute
  for disk-level secure erase or an HSM-backed KMS in a production
  deployment handling regulated personal data at scale.
