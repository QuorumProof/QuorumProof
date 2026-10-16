# Frequently Asked Questions

Answers to the questions that come up most often in issues, discussions and
support requests (issue #1639). Each answer is short and links to the doc
that covers the topic in full. Unfamiliar terms are defined in the
[glossary](./glossary.md).

Every question is its own heading, so it is indexed individually by the
interactive docs search ([interactive-documentation.md](./interactive-documentation.md)) —
search for a phrase from the question to jump straight to its answer.

**Sections:**
[General](#general) ·
[Credentials & quorum slices](#credentials--quorum-slices) ·
[Verification & privacy](#verification--privacy) ·
[API & integration](#api--integration) ·
[Deployment & operations](#deployment--operations) ·
[Upgrades & versions](#upgrades--versions) ·
[Contributing](#contributing)

---

## General

### What is QuorumProof?
A credential verification platform built on Stellar Soroban smart contracts.
Engineers assemble a [quorum slice](./glossary.md#quorum-slice) of trusted
institutions (university, licensing body, employers); those institutions
attest the engineer's credentials on-chain, and any employer can verify them
instantly without contacting each institution. See the
[README](../README.md) and [architecture.md](./architecture.md).

### Why use Federated Byzantine Agreement instead of a central registry?
There is no single global authority for engineering credentials across
countries. FBA lets each holder decide whom to trust, and verification
succeeds only when enough of those trusted parties agree. No central
registry can be compromised or become a bottleneck. See
[ADR-001](./adr/adr-001-fba-trust-model.md).

### Which contracts make up the system?
Three: `quorum_proof` (credentials, slices, attestations), `sbt_registry`
(soulbound tokens) and `zk_verifier` (zero-knowledge claim verification).
See [architecture.md](./architecture.md) and
[ADR-010](./adr/adr-010-three-contract-architecture.md).

### Is QuorumProof production-ready?
The core credential, slice and attestation flows are implemented. Some
cryptographic features are intentionally fail-closed stubs — for example
`verify_bulletproof_range` always returns `false`, and on-chain metadata
encryption/compression functions panic. The [README](../README.md#-zk-verification--implementation-status)
lists the current status of each.

---

## Credentials & quorum slices

### How many attestors should a quorum slice have?
Enough independent institutions that no single one can attest alone, but few
enough that attestations are collected promptly. Three to five attestors with
a threshold above half the total weight is a common starting point. See
[quorum-slice-guide.md](./quorum-slice-guide.md) and
[weighted-voting.md](./weighted-voting.md).

### What happens if an attestor becomes unavailable?
The credential stays verifiable as long as the remaining attestations still
meet the threshold. For new credentials, add a replacement attestor to the
slice. Attestor availability is exposed at
`GET /api/attestors/:address/status`. See
[SLICE_MIGRATION_GUIDE.md](./SLICE_MIGRATION_GUIDE.md).

### Can a soulbound token be transferred?
No — SBTs are non-transferable by design. The only exception is an
admin-gated ownership transfer for wallet recovery or legal name changes. See
[ADR-002](./adr/adr-002-sbt-non-transferability.md).

### What is the difference between revoking, suspending and expiring a credential?
**Revocation** is permanent. **Suspension** is temporary and can be lifted.
**Expiry** happens automatically when `expires_at` passes. All three make
verification fail. See [sbt-lifecycle.md](./sbt-lifecycle.md).

### I lost access to my wallet. Can I recover my credentials?
Yes, through the recovery flow (`/api/recovery/*`): request recovery naming
your lost and new wallets, verify by OTP, then the credential's attestors
approve the request before it is executed against your new address.
See [api-response-examples.md](./api-response-examples.md#recovery).

---

## Verification & privacy

### Is my personal data stored on-chain?
No. Only a 32-byte hash of your credential metadata goes on-chain; the
document itself stays off-chain. Ledger state is public, which is why
on-chain encryption is not offered. See [privacy-guide.md](./privacy-guide.md).

### How do I prove a claim without revealing the whole credential?
Use a zero-knowledge claim (e.g. `HasDegree`) verified by `zk_verifier`, or
BBS+ selective disclosure to reveal only chosen fields. See
[zk-verification-developer-guide.md](./zk-verification-developer-guide.md)
and [bbs-plus-tutorial.md](./bbs-plus-tutorial.md).

### Why does batch verification return fewer unique results than I sent?
It doesn't — results are returned one per input item, in input order.
Duplicate `(credential_id, claim_type)` pairs are *resolved* once and the
count is reported in `summary.duplicates_deduplicated`. See
[api-response-examples.md](./api-response-examples.md#post-apiverifybatch).

### How do I request erasure of my data under GDPR?
Off-chain personal data is erased by crypto-shredding: its encryption key is
destroyed. On-chain hashes cannot be deleted but reveal nothing on their own.
See [gdpr-compliance.md](./gdpr-compliance.md).

---

## API & integration

### Which API version should I use?
**v2** for all new integrations. v1 is in maintenance and is sunset on
2027-03-01, after which it returns `410 Gone`. See
[migration-guides.md](./migration-guides.md#api-v1--v2).

### Are there examples in my language?
Yes — Python, JavaScript, Rust and Go examples live in
[`examples/multi-language/`](../examples/multi-language/), with snippets in
[code-examples.md](./code-examples.md).

### How do I authenticate API requests?
Send an API key in the `x-api-key` header, or a Bearer JWT in
`Authorization`. OAuth2/OIDC is also supported under `/auth/oauth2`. See
[api-client-guide.md](./api-client-guide.md).

### Why am I getting `429 Too Many Requests`?
You have hit a rate limit (per API key, per IP, or a concurrency cap on
`/api/verify` and `/api/credentials`). Back off using the `Retry-After`
header and prefer batch endpoints. See [throttling.md](./throttling.md).

### Can the API server write to the contracts?
No. The API server is read-only: it serves reads by
[simulating](./glossary.md#simulation) contract calls. State changes are
signed and submitted by the caller. See
[ADR-015](./adr/adr-015-read-only-api-server-via-simulation.md).

### How do I receive events instead of polling?
Register a webhook with `POST /api/webhooks`, or subscribe over WebSocket or
GraphQL subscriptions. See [websocket-scaling.md](./websocket-scaling.md).

---

## Deployment & operations

### In what order are the contracts deployed?
`quorum_proof` first, then `zk_verifier`, then `sbt_registry`, which needs
the `quorum_proof` address at initialization. See [deployment-guide.md](./deployment-guide.md) and
[architecture.md](./architecture.md#deployment-order).

### How do I pause the system during an incident?
The admin calls `pause`. State-changing calls — and upgrades — are blocked
until `unpause`. See [disaster-recovery.md](./disaster-recovery.md) and
[OPERATOR_RUNBOOK.md](./OPERATOR_RUNBOOK.md).

### Where do I start when something is failing?
[troubleshooting-guide.md](./troubleshooting-guide.md) covers common
failures across contracts, API and infrastructure; error codes are listed in
[error-codes.md](./error-codes.md).

---

## Upgrades & versions

### How do I upgrade to a new release?
Follow the per-version steps in [migration-guides.md](./migration-guides.md):
check breaking changes, back up, upgrade, run migrations, verify — and know
the rollback procedure before you start.

### Can a contract upgrade be rolled back?
Yes: call `upgrade` again with the previous WASM hash, recorded in
`get_upgrade_history`. Storage migrations must be rolled back separately. See
[migration-guides.md](./migration-guides.md#rollback-procedures).

### Will upgrading change my contract address?
No. `upgrade` replaces the WASM in place; the contract address and its
storage are preserved.

---

## Contributing

### How do I run the tests?
`./scripts/test.sh` for the contracts and `npm test` in `api-server/`. See
[TESTING_COMPREHENSIVE_GUIDE.md](./TESTING_COMPREHENSIVE_GUIDE.md).

### I added a doc — why is CI failing?
Every `docs/*.md` file must be linked from [docs/README.md](./README.md).
Add a row to the relevant table and run `./scripts/check_docs_index.sh`.

### How do I report a security vulnerability?
Privately, as described in [SECURITY.md](../SECURITY.md). Do not open a
public issue.

### My question isn't answered here.
Search the docs with the [interactive docs](./interactive-documentation.md)
or open a docs-feedback issue. If the same question comes up more than once,
add it to this page (see below).

---

## Maintaining this FAQ

- **Adding a question:** add it as a `###` heading under the right `##`
  section, answer in a few sentences, and link the authoritative doc. Answers
  that grow past a paragraph belong in that doc instead.
- **Sources:** support requests, repeated issue/discussion questions and
  docs-feedback issues. Review them each release.
- **Search:** after editing, regenerate the search index so new questions are
  searchable:
  ```bash
  python3 scripts/build_docs_search_index.py
  ```

See also: [Glossary](./glossary.md) · [Code examples](./code-examples.md) ·
[Documentation index](./README.md)
