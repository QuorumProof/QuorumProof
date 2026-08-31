#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use quorum_proof::{QuorumIntersectionCertificate, QuorumProofContract, QuorumProofContractClient};
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Vec};

/// Fuzz `check_quorum_intersection` against adversarial slice configurations:
/// disjoint slices, single-attestor slices, and thresholds pinned to the
/// exact slice size.
///
/// FBA safety invariant under test: per the Stellar Consensus Protocol
/// whitepaper (D. Mazieres, "The Stellar Consensus Protocol", the quorum
/// intersection discussion in the Federated Byzantine Agreement section that
/// the project README links conceptually), an FBA system is only safe if any
/// two quorums share a node. `check_quorum_intersection` is the on-chain
/// guard for that: given a candidate "safe" node set and a list of slices, it
/// must never certify `is_safe = true` unless that candidate set actually
/// meets *every* listed slice's own weighted threshold. This target builds
/// two slices with a controllable attestor overlap (including zero — fully
/// disjoint slices) and asserts the contract only ever certifies safety when
/// the shared attestor set genuinely satisfies both thresholds.
#[derive(Arbitrary, Debug)]
struct FuzzInput {
    n_a: u8,
    n_b: u8,
    weight_a: u8,
    weight_b: u8,
    overlap: u8,
    threshold_a_seed: u8,
    threshold_b_seed: u8,
}

fuzz_target!(|input: FuzzInput| {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, QuorumProofContract);
    let client = QuorumProofContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let creator = Address::generate(&env);

    let n_a = (input.n_a as usize).clamp(1, 8);
    let n_b = (input.n_b as usize).clamp(1, 8);
    let overlap = (input.overlap as usize).min(n_a).min(n_b);

    // Build the shared ("intersection") attestor set first, then round each
    // slice out with attestors unique to it. When `overlap == 0` the two
    // slices are fully disjoint — the adversarial case this target targets.
    let mut shared: Vec<Address> = Vec::new(&env);
    for _ in 0..overlap {
        shared.push_back(Address::generate(&env));
    }

    let mut attestors_a = shared.clone();
    for _ in overlap..n_a {
        attestors_a.push_back(Address::generate(&env));
    }
    let mut attestors_b = shared.clone();
    for _ in overlap..n_b {
        attestors_b.push_back(Address::generate(&env));
    }

    let weight_a = (input.weight_a as u32).clamp(1, 20);
    let weight_b = (input.weight_b as u32).clamp(1, 20);

    let mut weights_a: Vec<u32> = Vec::new(&env);
    for _ in 0..attestors_a.len() {
        weights_a.push_back(weight_a);
    }
    let mut weights_b: Vec<u32> = Vec::new(&env);
    for _ in 0..attestors_b.len() {
        weights_b.push_back(weight_b);
    }

    let total_a = attestors_a.len() as u32 * weight_a;
    let total_b = attestors_b.len() as u32 * weight_b;
    // Threshold boundary conditions: this can land anywhere in [1, total],
    // including exactly `total` (threshold == slice size, when weight == 1).
    let threshold_a = (input.threshold_a_seed as u32 % total_a) + 1;
    let threshold_b = (input.threshold_b_seed as u32 % total_b) + 1;

    let slice_a = client.create_slice(&creator, &attestors_a, &weights_a, &threshold_a);
    let slice_b = client.create_slice(&creator, &attestors_b, &weights_b, &threshold_b);

    // The candidate "safe" node set under test IS the actual shared attestor
    // set: `safe_nodes` is meant to represent the true intersection, so this
    // is the honest use of the certificate API (as opposed to fuzzing
    // malformed certificates, which `check_quorum_intersection`'s own input
    // validation already rejects deterministically).
    let shared_weight_a = overlap as u32 * weight_a;
    let shared_weight_b = overlap as u32 * weight_b;
    let shared_meets_both = shared_weight_a >= threshold_a && shared_weight_b >= threshold_b;

    let mut slice_ids = Vec::new(&env);
    slice_ids.push_back(slice_a);
    slice_ids.push_back(slice_b);

    let proof_hash = Bytes::from_slice(&env, &[0u8; 32]);
    let certificate = QuorumIntersectionCertificate {
        slice_ids: slice_ids.clone(),
        safe_nodes: shared,
        proof_hash,
        signature: None,
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.check_quorum_intersection(&slice_ids, &certificate)
    }));

    match result {
        Ok(report) => {
            // The contract must never certify safety unless the shared set
            // actually meets both slices' thresholds. In particular, two
            // slices with zero shared attestors (overlap == 0) can never
            // reach this branch.
            assert!(
                shared_meets_both,
                "check_quorum_intersection reported is_safe without the \
                 candidate set meeting both slices' thresholds (overlap={})",
                overlap
            );
            assert!(report.is_safe);
        }
        Err(_) => {
            // Rejecting an insufficient candidate set is always correct. We
            // only flag a bug if it rejected a set that DID meet both
            // thresholds.
            assert!(
                !shared_meets_both,
                "check_quorum_intersection rejected a candidate set that met \
                 both slices' thresholds"
            );
        }
    }
});
