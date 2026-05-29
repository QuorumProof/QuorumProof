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
        /// Property: threshold cannot exceed attestor count after creation.
        #[test]
        fn prop_threshold_le_attestor_count(
            n_attestors in 1usize..=10,
            threshold_offset in 0u32..10,
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
            let total_weight = n_attestors as u32;
            let threshold = (threshold_offset % total_weight) + 1;

            let slice_id = client.create_slice(&creator, &attestors, &weights, &threshold);
            let slice = client.get_slice(&slice_id);

            prop_assert!(slice.threshold <= slice.attestors.len() as u32);
            prop_assert!(slice.threshold <= total_weight);
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
    }
}
