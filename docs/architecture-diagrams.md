# System Architecture Diagrams

> Issue #1644. These diagrams show how QuorumProof fits together: the overall
> system, how the contracts call each other, how data moves through a
> credential's lifecycle, and how the system is deployed. The prose reference is
> [architecture.md](./architecture.md). The design decisions behind the diagrams
> are recorded in the ADRs, especially
> [ADR-010 (three-contract architecture)](./adr/adr-010-three-contract-architecture.md)
> and [ADR-015 (read-only API server)](./adr/adr-015-read-only-api-server-via-simulation.md).

The diagrams are written in [Mermaid](https://mermaid.js.org/). GitHub renders
them inline, and you can edit them as plain text in a PR. If you change a
contract interface, a deployment manifest or a Terraform module, update the
matching diagram in the same PR.

---

## Table of Contents

1. [System architecture](#1-system-architecture)
2. [Contract interactions](#2-contract-interactions)
3. [Data flow](#3-data-flow)
4. [Deployment](#4-deployment)
5. [Keeping diagrams current](#5-keeping-diagrams-current)

---

## 1. System architecture

The Stellar ledger is the source of truth. Clients sign and submit writes with
their own wallets. The API server never holds user keys. It reads contract
state by simulating calls against Soroban RPC (ADR-015), and it adds indexing,
caching, notifications and analytics on top.

```mermaid
flowchart LR
    subgraph Clients
        FE[Frontend<br/>frontend/]
        DB_UI[Operator dashboard<br/>dashboard/]
        SDK[Integrators<br/>SDK / REST / GraphQL]
        W[Wallet<br/>signs transactions]
    end

    subgraph API["API server (api-server/)"]
        MW[Middleware<br/>auth · RBAC · rate limit · tracing]
        R[Routes<br/>REST v1/v2 · GraphQL · WebSocket]
        SVC[Services<br/>verification cache · search index ·<br/>notifications · analytics]
        CB[RPC circuit breaker]
    end

    subgraph Data["Off-chain data"]
        PG[(PostgreSQL)]
        RD[(Redis)]
        IPFS[(IPFS<br/>credential metadata)]
    end

    subgraph Stellar["Stellar network"]
        RPC[Soroban RPC]
        subgraph Contracts
            QP[quorum_proof]
            SBT[sbt_registry]
            ZK[zk_verifier]
        end
    end

    subgraph Obs["Observability (monitoring/)"]
        EXP[quorumproof-exporter]
        PROM[Prometheus]
        AM[Alertmanager]
        GRAF[Grafana]
        LOKI[Loki]
    end

    FE & SDK --> MW --> R --> SVC
    DB_UI --> MW
    SVC --> CB -->|simulate / getEvents| RPC
    SVC <--> PG
    SVC <--> RD
    FE -->|fetch metadata| IPFS
    FE & SDK --> W -->|signed tx| RPC
    RPC <--> QP & SBT & ZK
    EXP -->|reads contract state| RPC
    PROM -->|scrape /metrics| API
    PROM --> EXP
    PROM --> AM
    GRAF --> PROM & LOKI
```

| Component | Responsibility | Source |
|---|---|---|
| `quorum_proof` | Credentials, quorum slices, attestations, disputes, pause/admin | `contracts/quorum_proof` |
| `sbt_registry` | Soulbound tokens bound to credentials; non-transferable | `contracts/sbt_registry` |
| `zk_verifier` | Groth16 / PLONK proof verification over BLS12-381 | `contracts/zk_verifier` |
| API server | Read-only query layer, indexing, auth, notifications | `api-server/` |
| Frontend / dashboard | Holder, issuer and operator UIs | `frontend/`, `dashboard/` |
| Monitoring stack | Metrics, logs, alerts | `monitoring/` |

---

## 2. Contract interactions

### 2.1 Dependency graph

```mermaid
flowchart TD
    QP[quorum_proof]
    SBT[sbt_registry]
    ZK[zk_verifier]

    SBT -->|get_credential<br/>on every mint| QP
    QP -->|get_tokens_by_owner, get_token<br/>in verify_engineer| SBT
    QP -->|verify_claim / verify_groth16_proof<br/>in verify_engineer| ZK
```

`sbt_registry` stores the `quorum_proof` contract ID at initialization. That's
why it has to be deployed last (see
[Deployment order](./architecture.md#deployment-order)).

### 2.2 Issuance and attestation

```mermaid
sequenceDiagram
    autonumber
    actor Issuer
    actor Engineer as Engineer (subject)
    actor Att as Attestors<br/>(university, society, employer)
    participant QP as quorum_proof
    participant SBT as sbt_registry

    Engineer->>QP: create_slice(creator, attestors, weights, threshold)
    QP-->>Engineer: slice_id
    Issuer->>QP: issue_credential(issuer, subject, type, metadata_hash, expires_at, nonce)
    QP-->>Issuer: credential_id  (event: CredentialIssued)
    loop each attestor in the slice
        Att->>QP: attest(attestor, credential_id, slice_id, value, expires_at)
        QP-->>Att: event: AttestationRecorded
    end
    Note over QP: weighted threshold reached → credential attested
    Engineer->>SBT: mint(owner, credential_id, metadata_uri)
    SBT->>QP: get_credential(credential_id)
    QP-->>SBT: credential (must exist, not revoked)
    SBT-->>Engineer: token_id
```

### 2.3 Verification

```mermaid
sequenceDiagram
    autonumber
    actor V as Verifier (employer)
    participant API as API server
    participant RPC as Soroban RPC
    participant QP as quorum_proof
    participant SBT as sbt_registry
    participant ZK as zk_verifier

    V->>API: GET /verify/... (or direct contract call)
    API->>API: verification cache hit?
    alt cache miss
        API->>RPC: simulate verify_engineer(sbt_id, zk_id, subject, credential_id, claim, proof, vk_hash)
        RPC->>QP: verify_engineer(...)
        QP->>QP: credential exists, not revoked/expired, attested
        QP->>SBT: get_tokens_by_owner(subject)
        SBT-->>QP: token ids
        QP->>ZK: verify proof for claim_type
        ZK-->>QP: bool
        QP-->>RPC: result
        RPC-->>API: simulation result
        API->>API: cache result (invalidated on revoke events)
    end
    API-->>V: verified / not verified
```

### 2.4 Revocation and dispute

```mermaid
stateDiagram-v2
    [*] --> Issued: issue_credential
    Issued --> Attested: attest → weighted threshold met
    Issued --> Revoked: revoke_credential
    Attested --> Suspended: suspend_credential
    Attested --> Challenged: challenge_attestation
    Challenged --> Attested: challenge rejected
    Challenged --> Revoked: challenge upheld
    Attested --> Expired: expires_at passed
    Expired --> Attested: renew_credential
    Attested --> Revoked: revoke_credential
    Suspended --> Revoked: revoke_credential
    Revoked --> [*]
```

The states are simplified. The authoritative flags and error codes are in
[sdk-methods-reference.md](./sdk-methods-reference.md) and
[error-codes.md](./error-codes.md). SBT consequences are covered in
[sbt-lifecycle.md](./sbt-lifecycle.md).

---

## 3. Data flow

### 3.1 What lives where

```mermaid
flowchart LR
    subgraph OnChain["On-chain (public, permanent)"]
        C[Credential record<br/>issuer · subject · type ·<br/>metadata_hash · flags]
        S[Quorum slices<br/>attestors · weights · threshold]
        A[Attestations]
        T[SBTs]
        E[Contract events]
    end
    subgraph OffChain["Off-chain"]
        M[Credential metadata<br/>IPFS — encrypted/compressed by client]
        IDX[Indexed events,<br/>search index, analytics<br/>PostgreSQL]
        CACHE[Verification cache,<br/>sessions, rate limits<br/>Redis]
        LOG[Logs → Loki →<br/>cold-storage archive]
        BK[Backups / snapshots<br/>S3, versioned + encrypted]
    end

    M -. hash anchored in .-> C
    E -->|getEvents| IDX
    IDX --> CACHE
    C & S & A --> BK
    IDX --> BK
```

Rules the data flow enforces:

- **Personal data never goes on-chain.** Only a `metadata_hash` is stored. The
  metadata is encrypted off-chain before it's stored (see the README note on
  `encrypt_metadata`), and GDPR erasure uses crypto-shredding
  ([crypto-shredding-architecture.md](./crypto-shredding-architecture.md)).
- **The chain is authoritative.** PostgreSQL and Redis are rebuildable
  projections of contract events. If they disagree with the chain, the chain
  wins ([verification-cache-invalidation.md](./verification-cache-invalidation.md)).
- **Writes bypass the API server.** Clients sign transactions and submit them
  to RPC directly.

### 3.2 Event pipeline

```mermaid
sequenceDiagram
    participant QP as Contracts
    participant RPC as Soroban RPC
    participant L as API server<br/>event listener
    participant PG as PostgreSQL
    participant RD as Redis
    participant WS as WebSocket clients
    participant AM as Alertmanager

    QP-->>RPC: emit event (ledger N)
    loop poll
        L->>RPC: getEvents(startLedger, contractIds)
        RPC-->>L: events
    end
    L->>PG: persist + index
    L->>RD: invalidate affected verification cache keys
    L->>WS: push notification
    L->>AM: critical events (pause, upgrade, revocation spike)
```

---

## 4. Deployment

### 4.1 Runtime topology (production)

```mermaid
flowchart TB
    U[Users / integrators] --> R53[Route 53<br/>failover DNS + health checks]

    subgraph P["Primary region"]
        ALB1[ALB] --> SVC1[api-server service<br/>blue / green slots]
        SVC1 --> AUR1[(Aurora PostgreSQL<br/>primary)]
        SVC1 --> RED1[(Redis)]
        S31[(S3: backups + log archive)]
    end

    subgraph S["Secondary region (passive)"]
        ALB2[ALB] --> SVC2[api-server service]
        SVC2 --> AUR2[(Aurora PostgreSQL<br/>global replica)]
        S32[(S3 replica)]
    end

    R53 -->|healthy| ALB1
    R53 -.->|on failover| ALB2
    AUR1 -. global replication .-> AUR2
    S31 -. cross-region replication .-> S32
    SVC1 & SVC2 --> RPC[Soroban RPC<br/>primary + fallback provider]
    RPC --> NET[(Stellar mainnet<br/>quorum_proof · sbt_registry · zk_verifier)]
```

Defined in `infra/terraform/` (modules `network`, `compute`, `database`,
`storage`, `failover`, `log-archive`). Staging is a single-region version of
the same stack. Kubernetes manifests for the blue/green api-server are in
`k8s/blue-green/`. See [multi-region-failover.md](./multi-region-failover.md)
and [infrastructure-as-code.md](./infrastructure-as-code.md).

### 4.2 Release pipeline

```mermaid
flowchart LR
    PR[Pull request] --> CI[ci.yml<br/>build · test · lint ·<br/>docs-index · security]
    CI --> M[merge to main]
    M --> TD[testnet-deploy.yml<br/>deploy_testnet.sh]
    TD --> SM{testnet_smoke_test.sh}
    SM -->|fail| TR[testnet_rollback.sh<br/>restore manifest]
    SM -->|pass| IMG[api-server image<br/>container-scan.yml]
    IMG --> BG[blue-green-deploy.yml<br/>deploy to idle slot]
    BG --> HC{preview health<br/>checks pass?}
    HC -->|no| KEEP[keep traffic on<br/>current slot]
    HC -->|yes| SW[switch live Service<br/>selector]
    M -.->|contract release| UP[pre_upgrade_checks.sh →<br/>upgrade_rollback.sh]
```

The operator procedures for each step are in the
[Deployment Runbook](./runbook-deployment.md) and the
[Rollback Runbook](./runbook-rollback.md).

---

## 5. Keeping diagrams current

- Update the diagram in the **same PR** as the change it describes. Reviewers
  should ask for it.
- Keep node labels matched to real names (contract methods, script names,
  Terraform modules) so readers can grep for them.
- Preview locally with the [Mermaid Live Editor](https://mermaid.live) or any
  editor with Mermaid preview. GitHub renders the committed version.
- Stick to `flowchart`, `sequenceDiagram` and `stateDiagram-v2`, which render
  reliably on GitHub.
