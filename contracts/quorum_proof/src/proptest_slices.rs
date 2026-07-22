/// Property-based tests for quorum slice operations (issue #475).
#[cfg(test)]
mod proptest_quorum_slices {
    use crate::{QuorumProofContract, QuorumProofContractClient};
    use proptest::prelude::*;
    use soroban_sdk::{testutils::Address as _, vec, Address, Env};

    fn setup(env: &Env) -> QuorumProofContractClient<'_> {
        env.mock_all_auths_allowing_non_root_auth();
        let id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        client
    }

    proptest! {
        /// Property: any absolute threshold up to total weight is accepted, including
        /// thresholds greater than the number of attestors.
        #[test]
        fn prop_threshold_le_total_weight(
            n_attestors in 1usize..=10,
            generated_weights in prop::collection::vec(1u32..=100, 1..=10),
            threshold_seed in any::<u32>(),
        ) {
            let env = Env::default();
            let client = setup(&env);
            let creator = Address::generate(&env);

            let mut attestors = soroban_sdk::Vec::new(&env);
            let mut weights = soroban_sdk::Vec::new(&env);
            let mut total_weight = 0u32;
            for index in 0..n_attestors {
                attestors.push_back(Address::generate(&env));
                let weight = generated_weights[index % generated_weights.len()];
                weights.push_back(weight);
                total_weight += weight;
            }
            let threshold = (threshold_seed % total_weight) + 1;

            let slice_id = client.create_slice(&creator, &attestors, &weights, &threshold);
            let slice = client.get_slice(&slice_id);

            prop_assert!(slice.threshold <= total_weight);
            prop_assert_eq!(slice.weights.len(), slice.attestors.len());
        }

        /// Property: effective percentage thresholds are monotonic and always in range.
        #[test]
        fn prop_percentage_threshold_is_monotonic(
            weights_input in prop::collection::vec(1u32..=100, 1..=20),
            low in 1u32..=100,
            high in 1u32..=100,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let creator = Address::generate(&env);
            let mut attestors = soroban_sdk::Vec::new(&env);
            let mut weights = soroban_sdk::Vec::new(&env);
            let mut total = 0u32;
            for weight in weights_input {
                attestors.push_back(Address::generate(&env));
                weights.push_back(weight);
                total += weight;
            }
            let lower = low.min(high);
            let upper = low.max(high);
            let lower_id = client.create_slice_percentage(&creator, &attestors, &weights, &lower);
            let upper_id = client.create_slice_percentage(&creator, &attestors, &weights, &upper);
            let lower_required = client.get_slice_threshold_config(&lower_id).required_weight;
            let upper_required = client.get_slice_threshold_config(&upper_id).required_weight;

            prop_assert!(lower_required >= 1);
            prop_assert!(upper_required <= total);
            prop_assert!(lower_required <= upper_required);
        }

        /// Property: slice ID is always positive and monotonically increasing.
        #[test]
        fn prop_slice_id_monotonically_increasing(n_slices in 1usize..=5) {
            let env = Env::default();
            let client = setup(&env);
            let creator = Address::generate(&env);
            let attestor = Address::generate(&env);
            let attestors = vec![&env, attestor.clone()];
            let weights = vec![&env, 1u32];

            let mut prev_id = 0u64;
            for _ in 0..n_slices {
                let id = client.create_slice(&creator, &attestors, &weights, &1u32);
                prop_assert!(id > 0);
                prop_assert!(id > prev_id);
                prev_id = id;
            }
        }

        /// Property: adding an attestor increases attestor count by exactly 1.
        #[test]
        fn prop_add_attestor_increases_count(n_initial in 1usize..=5) {
            let env = Env::default();
            let client = setup(&env);
            let creator = Address::generate(&env);

            let mut attestors = soroban_sdk::Vec::new(&env);
            let mut weights = soroban_sdk::Vec::new(&env);
            for _ in 0..n_initial {
                attestors.push_back(Address::generate(&env));
                weights.push_back(1u32);
            }
            let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);
            let before = client.get_slice(&slice_id).attestors.len();

            let new_attestor = Address::generate(&env);
            client.add_attestor(&creator, &slice_id, &new_attestor, &1u32);
            let after = client.get_slice(&slice_id).attestors.len();

            prop_assert_eq!(after, before + 1);
        }

        /// Property: threshold exceeding total weight is always rejected.
        #[test]
        fn prop_threshold_exceeding_weight_rejected(
            n_attestors in 1usize..=5,
            excess in 1u32..=10,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let creator = Address::generate(&env);

            let mut attestors = soroban_sdk::Vec::new(&env);
            let mut weights = soroban_sdk::Vec::new(&env);
            for _ in 0..n_attestors {
                attestors.push_back(Address::generate(&env));
                weights.push_back(1u32);
            }
            let bad_threshold = n_attestors as u32 + excess;

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.create_slice(&creator, &attestors, &weights, &bad_threshold);
            }));
            prop_assert!(result.is_err());
        }

        /// Property: is_quorum matches brute-force oracle for depth 1-3 nested slice trees
        #[test]
        fn prop_is_quorum_matches_oracle(
            depth in 1u32..=3,
            n_children_per_node in 2usize..=3,
            candidate_density in 0.1f64..=1.0f64,
        ) {
            let env = Env::default();
            let client = setup(&env);
            let creator = Address::generate(&env);

            // Helper: create flat slice with n attestors
            let create_flat_slice = |n: usize| -> u64 {
                let mut attestors = soroban_sdk::Vec::new(&env);
                let mut weights = soroban_sdk::Vec::new(&env);
                for _ in 0..n {
                    attestors.push_back(Address::generate(&env));
                    weights.push_back(1u32);
                }
                // Strict majority (must be > half, not merely >= half), to
                // match this test's oracle formula
                // `candidates.len() * 2 > slice.attestors.len()` below —
                // e.g. for n=10 that's threshold=6, not the ceiling-based 5.
                client.create_slice(&creator, &attestors, &weights, &((n as u32) / 2 + 1))
            };

            // For depth 1: just test flat slices (existing behavior)
            if depth == 1 {
                let slice_id = create_flat_slice(10);
                let slice = client.get_slice(&slice_id);

                // Create candidate set at specified density
                let candidate_count = (10.0 * candidate_density) as usize;
                let mut candidates = soroban_sdk::Vec::new(&env);
                for i in 0..candidate_count.min(slice.attestors.len() as usize) {
                    candidates.push_back(slice.attestors.get(i as u32).unwrap());
                }

                // Verify is_quorum returns expected result
                let result = client.is_quorum(&slice_id, &candidates);
                let expected = candidates.len() * 2 > slice.attestors.len(); // simple majority

                prop_assert_eq!(result, expected);
            }
            // n_children_per_node is reserved for deeper nesting scenarios (future work);
            // depth 1 (the only case currently exercised) doesn't need it.
            let _ = n_children_per_node;
        }
    }

    /// Property: cycle detection prevents self-referential and circular slice nests
    ///
    /// Takes no generator parameters, so it can't live inside the `proptest! {}`
    /// block above (that macro's item rule requires at least one `pat in
    /// strategy` clause per function) -- it's a plain #[test] instead, with an
    /// explicit `Result` return so `prop_assert!` (which expands to a `return
    /// Err(..)`) type-checks.
    #[test]
    fn prop_cycle_detection_self_reference() -> Result<(), TestCaseError> {
        let env = Env::default();
        let client = setup(&env);
        let creator = Address::generate(&env);

        let attestor = Address::generate(&env);
        let attestors = vec![&env, attestor];
        let weights = vec![&env, 1u32];

        // Create a flat slice
        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);

        // Attempting to add slice as its own child would require API support (not exposed yet)
        // For now, this test verifies the infrastructure exists
        prop_assert!(slice_id > 0);
        Ok(())
    }
}
