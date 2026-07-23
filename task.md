# QuorumProof production-readiness pass — resume prompt

Continue the QuorumProof production-readiness pass. Last commit on main is either
`55a179a` (jurisdiction modeling) or one commit past it fixing
`get_slice_attack_cost_estimate` (was a fake-constant placeholder, now real
stake-weighted attack-cost math) plus a real production bug in
`challenge_attestation`/`vote_on_challenge` (read `DataKey::Attestors` as
`Vec<Address>`, actually stores `Vec<AttestationRecord>` — panics on any real
challenge) — check `git log -3` in `contracts/quorum_proof` to see which landed.

Still open:
- (a) confirm that commit actually pushed clean (full `cargo test --target
  x86_64-unknown-linux-gnu --lib -p quorum_proof` was running in the
  background when the session ended — check it finished green before trusting
  the fix).
- (b) wire `monte_carlo_sweep` in
  `contracts/quorum_proof/src/simulation_agent_based.rs` into an actual test
  (still dead code, never called — `cargo test ... --no-run` shows the
  "method `monte_carlo_sweep` is never used" warning).
- (c) decide whether to tackle the disabled `feature_tests`/`doc_tests`
  modules in `contracts/quorum_proof/src/lib.rs` (~1600 lines, 100+ dead
  tests, permanently disabled via `#[cfg(all(test, any()))]` — `any()` with no
  args is always false). Flipping it back on surfaces 144 compile errors:
  stale `CredentialInput`/`ChallengeStatus`/`BatchResult` types, wrong arg
  counts, missing methods (`get_active_metadata_schema_version`,
  `set_credential_expiry`, `auto_revoke_expired_credentials`, etc). Likely a
  separate multi-hour rewrite project, not a quick fix — probably just flag it
  to the user rather than doing it silently.

## Context from the original audit (15-item list, 4 picked)

1. BBS+ selective-disclosure credentials (`contracts/bbs_plus_v1`) — DONE.
   Real signing/verification/selective-disclosure/revocation, 45/45 tests
   passing in 3 build configs incl. `wasm32-unknown-unknown`. Still **not
   wired into `quorum_proof`/`sbt_registry`**, still **excluded from the root
   workspace/CI**, and has had **no external cryptographic audit**.
2. api-server test suite actually passes at runtime — DONE (`npm test` run,
   5 stale tests fixed).
3. Light-client bridge gap (`crossChainBridge.ts` trusting RPC provider) —
   DONE. Real BLS sync-committee verification (Altair light-client protocol,
   SSZ Merkle proofs) for Ethereum mainnet/Sepolia.
4. Jurisdiction modeling + economic-security simulation wiring — IN PROGRESS:
   - Jurisdiction modeling in `api-server/src/searchIndex.ts` — DONE, pushed
     in `55a179a`. Hierarchical ISO 3166-1/3166-2 + supranational group
     (EU) codes, indexed and filterable/facetable, 23 new tests.
   - Economic-security simulation wiring — partially done this session (see
     "Still open" above): `get_slice_attack_cost_estimate` now does real
     stake-weighted greedy set-cover instead of hardcoded placeholder
     constants, with 5 new integration tests driving real `create_slice`/
     `attest`/`challenge_attestation`/`vote_on_challenge`/
     `deposit_attestor_stake` calls. `monte_carlo_sweep` (off-chain Monte
     Carlo variance sweep in `simulation_agent_based.rs`) is still dead code,
     never called from anywhere.

## Remaining 11 audit items not yet started

(Not detailed here — re-derive from the original audit if needed, or ask the
user for the list again.)
