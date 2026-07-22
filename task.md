Description
Priority: High

Description: verify_batch_proofs (contracts/zk_verifier/src/lib.rs, ~line 1045) verifies each proof in a batch independently via verify_groth16_proof, per its own doc comment — an O(n) cost profile that will hit Soroban's per-transaction CPU-instruction ceiling as batch sizes grow for bulk credential issuance.

Tasks:

Implement a proof-aggregation/accumulation scheme for Groth16 (e.g. SnarkPack-style, or a folding scheme) so verifying n proofs costs sublinearly
Preserve per-credential public-input binding so aggregation doesn't lose per-credential accountability
Write a formal soundness argument covering whether an adversary could get an aggregate accepted with an invalid constituent proof
Add a new aggregation entry point (keep verify_batch_proofs for backward compatibility, or replace it with justification)
Add tests proving a batch with exactly one invalid proof among valid ones is rejected in its entirety
Add gas benchmarks at batch sizes 5/25/50/100 extending the existing batch_verify (5) baseline
Add a fuzz target for aggregate-proof deserialization