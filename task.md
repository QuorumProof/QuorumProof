# QuorumProof production-readiness pass — resume prompt

Continue the QuorumProof production-readiness pass. Last commit on main is
`45497af` (wires `monte_carlo_sweep` into real tests). History:
`55a179a` (jurisdiction modeling) → `0d31908` (real
`get_slice_attack_cost_estimate` stake-weighted math + fixed the
`challenge_attestation`/`vote_on_challenge` panic-on-real-challenge bug) →
`45497af` (this session).

Status of the three items from last resume:
- (a) DONE. Full `cargo test --target x86_64-unknown-linux-gnu --lib -p
  quorum_proof` confirmed green: 251 passed, 0 failed. `0d31908`'s fixes are
  solid.
- (b) DONE, with a finding surfaced, not silently fixed. Added two tests in
  `economic_security_tests.rs` that call `monte_carlo_sweep` for real. One
  test documents a real discovery: the off-chain attack-cost model
  (`simulate_corrupt_existing`/`simulate_sybil`/`concentration_risk_score`)
  keys off `base_weight` and `corruption_price` only — it never reads
  `AttestorAgent::effective_weight()` — so sweeping different reputation
  distributions through `monte_carlo_sweep` currently produces byte-identical
  results every trial. The "variance" the function's own doc comment claims
  to measure is a no-op today. This is a real gap versus the on-chain
  contract, which *does* weight consensus by reputation via
  `get_effective_weight` (lib.rs) when `reputation_weighting_enabled` is set.
  **Not fixed** — deciding how the off-chain simulator should incorporate
  reputation (mirror `get_effective_weight` exactly? apply it only to
  `concentration_risk_score`? something else?) is a design call, not a
  mechanical fix. Flag to user next session if not already discussed.
- (c) Still undecided — same disabled `feature_tests`/`doc_tests` situation as
  before (~1600 lines in `lib.rs`, 144 compile errors if re-enabled, likely a
  multi-hour rewrite). Not started; still needs a user decision on whether
  it's in scope.

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
4. Jurisdiction modeling + economic-security simulation wiring — DONE
   (mechanically complete; one design gap flagged, see item (b) above):
   - Jurisdiction modeling in `api-server/src/searchIndex.ts` — pushed in
     `55a179a`. Hierarchical ISO 3166-1/3166-2 + supranational group (EU)
     codes, indexed and filterable/facetable, 23 new tests.
   - Economic-security simulation wiring — `get_slice_attack_cost_estimate`
     now does real stake-weighted greedy set-cover instead of hardcoded
     placeholder constants (`0d31908`), with 5 new integration tests driving
     real `create_slice`/`attest`/`challenge_attestation`/
     `vote_on_challenge`/`deposit_attestor_stake` calls.
     `monte_carlo_sweep` (off-chain Monte Carlo variance sweep in
     `simulation_agent_based.rs`) is now wired into real tests (`45497af`)
     but exposed that reputation currently has zero effect on its output —
     see (b) above for the open design question.

## Remaining 11 audit items not yet started

(Not detailed here — re-derive from the original audit if needed, or ask the
user for the list again.)
