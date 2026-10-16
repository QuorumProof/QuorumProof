# ADR-015: Keyless API Server — Chain Reads via Transaction Simulation

## Status

Accepted

## Date

2026-09-26

## Context

Integrators such as HR systems, applicant tracking tools and background-check
vendors want a plain HTTP API. They don't want to embed the Stellar SDK, manage
keys or pay fees just to *check* a credential. Searching and paging across many
credentials is also awkward to do directly against contract methods.

## Problem Statement

How should off-chain clients read QuorumProof state, where should
credential state live, and should the API server be able to write on-chain?

## Alternatives Considered

### Option 1: Clients call the contracts directly

**Pros**: No extra infrastructure, and fully trustless.

**Cons**: A heavy integration burden. Search and aggregation logic gets
duplicated in every client.

### Option 2: Indexer with its own database

**Pros**: Fast, rich queries.

**Cons**: A second source of truth that can drift or be tampered with, plus a
database to operate.

### Option 3: Keyless API server; chain state via simulation (chosen)

**Pros**: No signing keys. Every credential answer comes from current contract
state. Off-chain operational data (API keys, webhooks, audit logs, search
indexes) can still live in Postgres without becoming a second source of truth
for credentials.

**Cons**: Each uncached chain read costs RPC round-trips. Caches and indexes
must be invalidated or rebuilt when chain state changes.

## Decision

- `api-server/` reads contract state only through `simulateCall`, which
  simulates a transaction against Soroban RPC and never submits it. The
  simulation source account is an ephemeral random keypair, so the server holds
  no signing keys.
- On-chain writes (issuing, attesting, revoking) stay client-side, signed by
  the actor's own wallet.
- Postgres (`api-server/src/db.ts`) stores only off-chain operational data:
  API keys, webhooks, audit and analytics records, search index snapshots.
  The contracts remain the only source of truth for whether a credential
  exists, is attested or is revoked. Cached or indexed credential data must be
  derivable from chain state and safe to rebuild.

## Rationale

A keyless server can't be used to forge or revoke credentials even if it is
compromised. The worst it can do is return wrong answers, and any verifier can
check those against the chain. Keeping credential truth on-chain means the
database can be lost or rebuilt without losing credential state.

## Consequences

### Positive

- The server holds no private keys and has no on-chain write path.
- Losing the database loses operational data only, never credential state.

### Negative

- Latency and throughput depend on the RPC provider.
- In-process caches and search indexes make the server long-lived and
  stateful in memory, so leaks accumulate over time (see the longevity harness).

### Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Long-running server leaks memory or sockets | Med | Med | Longevity harness (`api-server/longevity/`, [docs/longevity-testing.md](../longevity-testing.md)) |
| Vulnerable dependency or base image | Med | Med | npm audit and Trivy image scans in `.github/workflows/security.yml` |
| RPC outage | Med | Med | Configurable `STELLAR_RPC_URL`; 5xx surfaced to clients |

## Related Code

- `api-server/src/soroban.ts`: `simulateCall`
- `api-server/src/db.ts`: Postgres pool for off-chain data
- `api-server/src/routes/credentials.ts`, `api-server/src/routes/slices.ts`
- `api-server/Dockerfile`

## References

- [docs/api-client-guide.md](../api-client-guide.md)
- [Soroban RPC simulateTransaction](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/simulateTransaction)
