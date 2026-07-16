### 1. Implement On-Chain FBA Quorum-Slice Intersection Verification & Byzantine-Safe Federated Consensus
**Labels:** `security`, `quorum-proof`, `Stellar Wave`, `enhancement`, `research`
**Priority:** High

**Description:**
`docs/adr/adr-001-fba-trust-model.md` commits QuorumProof to real Federated Byzantine Agreement (à la Stellar's SCP), but the actual implementation in `contracts/quorum_proof/src/lib.rs` (see `docs/weighted-voting.md`) is only flat, single-level weighted-threshold voting — `achieved_weight = sum(captured_weight(attestation)); consensus = achieved_weight >= required_weight`. There is no notion of nested quorum slices, no quorum-intersection safety check, no v-blocking, and no equivocation-aware quorum exclusion. Nothing currently prevents two mutually-untrusting sub-networks from each independently attesting conflicting claims about the same credential with no shared trust anchor.

**Tasks:**
- Add a `QuorumSliceNode` type supporting nested slice references up to a configurable `MAX_SLICE_DEPTH`, with cycle detection at write time
- Implement `is_quorum(env, slice_id, candidate_nodes) -> bool` per the SCP recursive quorum-function definition, verified against a brute-force oracle via `proptest`
- Implement `check_quorum_intersection(env, slice_ids) -> IntersectionReport` using an off-chain-certificate / on-chain-verifier ("verify, don't solve") pattern so cost stays within Soroban's CPU budget
- Wire equivocating attestors into the existing `ForkDetected`/`ForkAlreadyResolved` error paths so they're excluded from quorum computation until resolved
- Preserve all existing flat `Slice`/threshold tests unmodified (nested slices are additive, depth-1 degenerate case)
- Add `docs/adr/adr-005-quorum-intersection-verification.md` with a formal safety proof sketch and explicit non-goals
- Add gas-cost benchmarks (`env.budget()`) for the intersection check at 10/25/50/100-node graph sizes

---

### 2. Implement Anonymous Multi-Show BBS+ Selective-Disclosure Credentials
**Labels:** `zk-verifier`, `security`, `enhancement`, `Stellar Wave`
**Priority:** High

**Description:**
`contracts/zk_verifier/src/lib.rs` already implements `verify_conditional_disclosure`, `verify_claim_with_schnorr_proof` (keyed to one registered public key via `set_schnorr_public_key`), and bulletproof range proofs — but these single-key schemes are linkable: any party observing multiple presentations verified against the same registered key can correlate them, even without learning the attribute value. This undermines the "Privacy-First" claim in `README.md` for holders who present credentials repeatedly across many verifiers.

**Tasks:**
- Implement a BBS+ multi-message signature scheme so an issuer can sign multiple attributes (credential type, jurisdiction, issue date) in one signature
- Implement the ZK presentation proof for selective disclosure of attribute subsets/predicates, reusing existing bulletproof range-proof machinery where applicable
- Demonstrate unlinkability across repeated presentations of the same credential (statistical/cryptographic test, not code inspection)
- Add cryptographic-accumulator-based revocation that doesn't itself leak a stable linkable identifier
- Integrate with existing admin-controlled key rotation / audit-trail conventions already used for Groth16/PLONK/Schnorr
- Add gas benchmarks and integration tests through `quorum_proof`'s claim-verification call sites
- Confirm all existing Schnorr/bulletproof/conditional-disclosure tests continue to pass

---

### 3. Add Adversarial Economic-Security Simulation Suite for Attestor Collusion & Sybil Resistance
**Labels:** `quorum-proof`, `security`, `research`, `Stellar Wave`
**Priority:** High

**Description:**
`docs/weighted-voting.md` documents, but leaves entirely unenforced, the risk that "if `maximum_weight >= required_weight`, one attestor can decide consensus alone." There is no bonding, slashing, Sybil-resistant weighting, or simulation quantifying what it would actually cost an adversary to capture a given slice's threshold — a gap in exactly the "collusion and fraud" resistance `docs/adr/adr-001-fba-trust-model.md` claims as a design goal.

**Tasks:**
- Build a formal cost-of-attack model over a slice's attestor set/weights/threshold (corrupt-existing-attestor and stand-up-Sybil-attestor strategies, each with a parameterized real-world cost)
- Validate the model with a Monte Carlo / agent-based simulation across varied slice configurations
- Add a queryable `get_slice_attack_cost_estimate`-style view surfacing computed attack cost per slice
- Implement at least one concrete mitigation (bonded stake + slashing on proven equivocation via `ForkDetected`, or Sybil-resistant reputation-tied weighting)
- Demonstrate before/after attack-cost measurements showing the mitigation raises cost for representative configurations
- Document methodology and assumptions in `docs/economic-security-model.md`
- Confirm `weighted_voting_tests.rs` and related tests continue to pass

---

## Smart Contracts

### 4. Implement Real PLONK Verifier with Universal SRS & KZG Polynomial Commitments
**Labels:** `zk-verifier`, `security`, `enhancement`, `Stellar Wave`
**Priority:** High

**Description:**
`plonk_verify` in `contracts/zk_verifier/src/lib.rs` (~line 139) only performs proof-length, public-input-alignment, and non-zero-commitment structural checks plus predicate/vk-binding helpers — no actual pairing/KZG math. `verify_plonk_proof` will currently accept any well-formed-looking but cryptographically meaningless byte string, the same class of gap that motivated #651 for Groth16, except PLONK's whole point is a universal, circuit-independent SRS.

**Tasks:**
- Implement real KZG commitment verification (pairing check) inside Soroban's execution model, targeting a pairing-friendly curve feasible within its CPU budget (BLS12-381 is the likely target)
- Support a universal SRS plus circuit-specific verifier keys derived from it, replacing the monolithic per-circuit `vk_hash` model
- Keep `verify_plonk_proof`'s public signature stable; change internals only
- Reuse existing admin-controlled key-rotation/audit-trail conventions already established for Groth16
- Add tests proving genuine valid/invalid/wrong-key proof handling (not just structural rejection) and that `test_verify_plonk_proof_groth16_proof_rejected` still passes for the correct cryptographic reason
- Add gas benchmarks to `benches/tests/benchmarks.rs`
- Document SRS format and key-derivation in `docs/plonk-verification.md`

---

### 5. Implement Recursive SNARK Proof Aggregation for Sublinear Batch Verification
**Labels:** `zk-verifier`, `performance`, `security`, `Stellar Wave`
**Priority:** High

**Description:**
`verify_batch_proofs` (`contracts/zk_verifier/src/lib.rs`, ~line 1045) verifies each proof in a batch independently via `verify_groth16_proof`, per its own doc comment — an O(n) cost profile that will hit Soroban's per-transaction CPU-instruction ceiling as batch sizes grow for bulk credential issuance.

**Tasks:**
- Implement a proof-aggregation/accumulation scheme for Groth16 (e.g. SnarkPack-style, or a folding scheme) so verifying n proofs costs sublinearly
- Preserve per-credential public-input binding so aggregation doesn't lose per-credential accountability
- Write a formal soundness argument covering whether an adversary could get an aggregate accepted with an invalid constituent proof
- Add a new aggregation entry point (keep `verify_batch_proofs` for backward compatibility, or replace it with justification)
- Add tests proving a batch with exactly one invalid proof among valid ones is rejected in its entirety
- Add gas benchmarks at batch sizes 5/25/50/100 extending the existing `batch_verify (5)` baseline
- Add a fuzz target for aggregate-proof deserialization

---

### 6. Add Formal Storage-Migration Invariant Verification for Live Contract Upgrades
**Labels:** `quorum-proof`, `security`, `infrastructure`, `Stellar Wave`
**Priority:** High

**Description:**
`docs/contract-upgrade-strategy.md` and open issue #1009 cover *how* to deploy an upgrade, but nothing verifies a migration is *correct* across the interlinked storage of `quorum_proof`, `sbt_registry`, and `zk_verifier` (per the cross-contract call map in `docs/architecture.md`). A migration that drops a weight cache or orphans an SBT-to-credential reference has no tooling to catch it before shipping.

**Tasks:**
- Define a formal invariant set (no orphaned SBT-to-credential references, slice weight caches match live attestor-weight sums, no ID collisions post-migration, revocation/expiry state preserved)
- Build a snapshot-diff or model-checking harness (evaluate Kani vs. a custom before/after storage differ) that runs a candidate migration and asserts invariants hold
- Integrate as a CI verification gate that must pass before a migration PR merges
- Add ≥5 concrete migration scenarios as positive tests and ≥3 deliberately-broken migrations as negative tests
- Document the invariant list in `docs/migration-invariants.md`, cross-referenced from `docs/contract-upgrade-strategy.md`
- Document what the harness does and does not guarantee

---

## Integration

### 7. Replace HMAC-Secret Cross-Chain Anchor Verification with a Trust-Minimized Light-Client Bridge
**Labels:** `security`, `api-server`, `enhancement`, `Stellar Wave`
**Priority:** High

**Description:**
`api-server/src/services/crossChainBridge.ts` computes its cross-chain proof commitment via HMAC keyed by `BRIDGE_HMAC_SECRET` — the entire cross-chain guarantee reduces to trusting whoever holds that one secret. Its own comments call `decodeEthEvent` "intentionally minimal" and note the in-memory anchor stores should "replace with DB in production." None of this is currently trust-minimized despite the bridge terminology.

**Tasks:**
- Implement Merkle-Patricia-trie receipt/log proof verification against a relayed, checkpointed block header with finality checks
- Remove the HMAC-secret trust assumption from the verification path; document precisely what trust assumption remains (e.g. confirmation depth)
- Replace in-memory `Map`-based anchor stores with durable persistence surviving a service restart
- Replace environment-variable topic matching in `decodeEthEvent` with real ABI-based log decoding against a pinned, version-controlled ABI
- Add a test proving a forged event (valid under the old HMAC scheme) is now rejected
- Add an integration test against a local EVM testnode (Anvil/Hardhat) proving the full pipeline end-to-end
- Keep `api-server/src/routes/bridge.ts`'s existing contract call shape stable unless a change is justified

---

### 8. Add Cryptographically Verifiable Oracle Bridge for Government Licensing Registries
**Labels:** `security`, `api-server`, `enhancement`, `documentation`
**Priority:** High

**Description:**
`docs/government-licensing-integration.md` states outright that "third-party verifiers trust both the QuorumProof attestation quorum **and** the backing official record" — the reference implementation is a plain HTTPS fetch with no cryptographic artifact proving what the registry actually returned. A dishonest or compromised issuer integration currently has nothing stopping it from issuing a credential the real registry wouldn't support.

**Tasks:**
- Design a mechanism proving a specific TLS session with a specific registry endpoint returned a specific response (TLSNotary/zkTLS-style, or a signed-oracle-committee fallback if full zkTLS is out of scope)
- Bind the resulting proof to the specific `issue_credential` call it backs, independently re-verifiable later
- Handle registry-response staleness (fetch timestamp in the proof; freshness policy enforced)
- Extend `docs/government-licensing-integration.md`'s protocol to require the proof, with a migration path for existing legacy issuers
- Implement an explicitly-labeled fallback tier for registries that can't support the chosen proof mechanism (no silent trust downgrade)
- Add tests for tamper detection, staleness rejection, and a full worked end-to-end example

---

### 9. Build an Exactly-Once, Ordered, Durable Webhook Delivery System
**Labels:** `api-server`, `enhancement`, `infrastructure`, `Stellar Wave`
**Priority:** High

**Description:**
`api-server/src/services/webhooks.ts` stores registrations in a bare `Map`, delivers via a fire-and-forget loop with a hardcoded `MAX_RETRIES = 3`, and logs to an in-process array. None of it survives a restart, there's no ordering guarantee across events for the same credential, no idempotency key, no dead-letter queue, and no per-endpoint circuit breaking.

**Tasks:**
- Add durable storage so registrations and in-flight deliveries survive a process restart
- Add a stable idempotency key per delivery; document the guarantee precisely (at-least-once + idempotency key, not true exactly-once)
- Enforce strict per-credential delivery ordering even under retries
- Add a dead-letter queue with replay tooling once retries are exhausted
- Add per-endpoint circuit breaking, reusing the operational pattern already established in `contracts/quorum_proof/src/circuit_breaker.rs`
- Preserve the existing `X-QuorumProof-Signature` HMAC delivery-signing behavior
- Add restart-durability, ordering-under-retry, idempotent-redelivery, and circuit-breaker trip/recovery tests

---

## Performance

### 10. Build a Horizontally-Scalable Real-Time Event Broadcast Layer
**Labels:** `api-server`, `performance`, `infrastructure`, `Stellar Wave`
**Priority:** High

**Description:**
`api-server/src/ws/server.ts` and `ws/subscriptions.ts` hold all subscriber/broadcast state in one process's memory. Once `api-server` runs as more than one replica — the normal shape implied by `docs/multi-region-deployment.md` — a client connected to instance A never receives an event only observed by instance B, with no error surfaced.

**Tasks:**
- Introduce a shared pub/sub backbone (e.g. Redis Pub/Sub or NATS) across instances so events reach every subscribed client regardless of connection point
- Preserve existing filter semantics exactly (`credential_id`, `issuer`, `holder`, `event_type`)
- Preserve the dashboard-subscriber path (`liveDashboard.ts`) under the same cross-instance model
- Add bounded per-connection send queues with a defined, documented backpressure/drop policy
- Extend `ws/metrics.ts` to be aggregable across instances
- Add a multi-process integration test proving cross-instance delivery within a defined latency bound (e.g. p99 < 200ms)
- Add a load test at a stated concurrent-connection target (e.g. 10k connections across N instances)

---

### 11. Add Asymptotic Gas-Complexity Profiling & Historical Regression-Tracking
**Labels:** `performance`, `testing`, `quorum-proof`, `infrastructure`
**Priority:** High

**Description:**
`benches/tests/benchmarks.rs` already benchmarks `env.budget()` CPU/memory cost against hardcoded thresholds (`measured_baseline × 1.10`), but only at one fixed input size per operation (e.g. `batch_verify (5)` is never tested at larger n). An operation with hidden quadratic behavior would pass today's fixed-size benchmarks while becoming unusable at realistic production scale.

**Tasks:**
- Parameterize existing benchmarked operations across a range of input sizes (e.g. 5/25/50/100/250/500)
- Fit and report the empirical complexity class per operation, flagging any worse-than-expected growth
- Persist historical measurements across commits/CI runs so gradual regressions are visible, not just single-PR jumps
- Preserve the existing fixed-threshold pass/fail gate as an additive layer, not a replacement
- Produce a human-readable complexity-curve report artifact attached to CI runs
- Add a seeded negative test proving a deliberately-introduced quadratic operation is correctly flagged

---

### 12. Build a Resumable, Gas-Bounded Live-State Migration Pipeline
**Labels:** `quorum-proof`, `infrastructure`, `devops`, `performance`
**Priority:** High

**Description:**
`docs/contract-upgrade-strategy.md` and `docs/disaster-recovery.md` describe upgrade procedures, but a live deployment with meaningful history (many thousands of `Credential`/`Slice`/SBT records) cannot have its storage migrated in one transaction under Soroban's hard per-invocation CPU/memory ceiling — and there's no mechanism today for resuming a partially-completed migration or guaranteeing it isn't double-applied.

**Tasks:**
- Design a paginated/chunked migration protocol with an on-chain progress cursor
- Guarantee idempotency: re-running a completed migration step must be a safe no-op
- Make the off-chain orchestrator crash-safe, resuming from the last checkpoint without operator intervention
- Keep reads (and ideally not-yet-migrated writes) available throughout — document exactly what is and isn't available mid-migration
- Expose migration progress via the existing `monitoring/` stack
- Add a large-synthetic-dataset test proving successful multi-step completion plus a kill/restart test proving no duplication or data loss
- Add concurrent-read-during-migration tests

---

## Database Design

### 13. Build a Sub-100ms Multi-Jurisdiction Credential Query Engine
**Labels:** `api-server`, `performance`, `infrastructure`, `Stellar Wave`
**Priority:** High

**Description:**
`api-server/src/searchIndex.ts` (674 lines) implements the entire credential search/index/facet system as an in-process `Map` plus a hand-rolled inverted index — no persistence (full rebuild required after every restart), no horizontal-scaling story, and no query-plan optimization. Realistic multi-jurisdiction filtered+ranked queries will degrade badly as the dataset grows past one process's memory.

**Tasks:**
- Design a persistent, properly-indexed storage architecture (evaluate a relational store with composite/partial indexes vs. a dedicated search engine) and justify the choice
- Preserve or improve existing tokenized search, faceted aggregation, and scoring behavior
- Hit a concrete sub-100ms p99 target for ≥5 representative multi-field jurisdiction queries at ≥1,000,000 indexed credentials, measured not asserted
- Handle correctness under concurrent on-chain event ingestion (out-of-order delivery, idempotent replay, reorgs where applicable)
- Provide a migration path from the current in-memory index without requiring downtime
- Confirm multiple `api-server` instances query a shared, consistent index rather than independent copies

---

### 14. Implement Cryptographic Right-to-Erasure (Crypto-Shredding) for GDPR
**Labels:** `security`, `api-server`, `documentation`, `Stellar Wave`
**Priority:** High

**Description:**
`api-server/src/routes/gdpr.ts`'s entire erasure flow is an in-memory `Map` of request objects whose `status` flips to `'anonymized'` once enough "consents" (also just pushed into an array) are collected — no code path ever touches the actual credential or metadata data, on-chain or off-chain. Given the ledger's immutability (`docs/adr/adr-002-sbt-non-transferability.md`), "erasure" needs a precise cryptographic meaning, not a status label.

**Tasks:**
- Store personal data off-chain, encrypted per-subject, with only a commitment/hash on-chain
- Implement genuine key destruction as the erasure mechanism (destroying a subject's decryption key so ciphertext becomes permanently unrecoverable, even to the operator)
- Precisely document what remains verifiable post-erasure vs. what becomes inaccessible, as a first-class spec (`docs/crypto-shredding-architecture.md`)
- Bind attestor "consent" to real cryptographic signatures verified against actual `get_attestors` results, not a raw address-string count
- Make GDPR request/consent state durable across restarts
- Add a test proving previously-stored data is genuinely unrecoverable post-erasure (not just a status-flag check)
- Confirm `api-server/tests/gdpr.test.ts` scenarios still pass or document intentional changes

---

### 15. Build a Consistent-Hashing Distributed Credential Store with Replication & Live Rebalancing
**Labels:** `api-server`, `performance`, `infrastructure`
**Priority:** High

**Description:**
`api-server/src/services/shardedStorage.ts` uses a fixed `shardCount = 8` with plain `hashAddress(address) % shardCount` sharding across in-process `Map`s — no persistence, no replication, and changing `shardCount` remaps close to 100% of existing keys since modulo sharding has none of consistent hashing's ~1/N remap-on-resize property.

**Tasks:**
- Replace modulo-based `getShardIndex` with consistent (or rendezvous/HRW) hashing so resizing remaps only ~1/N of keys
- Add real persistence per shard
- Add a configurable replication factor with quorum-based reads/writes (Dynamo-style N/R/W parameters)
- Implement live rebalancing on shard/node-count change with zero read/write downtime
- Preserve the existing public interface (`set`/`get`/`getBySubject`/`getAll`/`delete`/`getShardStats`/`totalSize`) as much as possible
- Add a test measuring the actual remap fraction on resize (should be ~1/N, not ~100%)
- Add a node-failure test proving data remains readable via quorum from surviving replicas


