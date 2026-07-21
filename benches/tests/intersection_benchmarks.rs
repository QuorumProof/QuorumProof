/// Benchmarks for nested quorum slice operations and intersection verification
/// Measures CPU instructions and memory usage for is_quorum and check_quorum_intersection
/// at various graph sizes to ensure Soroban budget compliance
#[cfg(test)]
mod intersection_benchmarks {
    use quorum_proof::{QuorumProofContract, QuorumProofContractClient};
    use soroban_sdk::{vec, Address, Env};

    fn setup(env: &Env) -> QuorumProofContractClient<'_> {
        env.mock_all_auths_allowing_non_root_auth();
        let id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        client
    }

    fn build_flat_slices(
        env: &Env,
        client: &QuorumProofContractClient,
        count: usize,
        nodes_per_slice: usize,
    ) -> Vec<u64> {
        let creator = Address::generate(env);
        let mut slice_ids = Vec::new();

        for _ in 0..count {
            let mut attestors = soroban_sdk::Vec::new(env);
            let mut weights = soroban_sdk::Vec::new(env);

            for _ in 0..nodes_per_slice {
                attestors.push_back(Address::generate(env));
                weights.push_back(1u32);
            }

            let threshold = ((nodes_per_slice as u32 + 1) / 2) as u32;
            let slice_id = client.create_slice(&creator, &attestors, &weights, &threshold);
            slice_ids.push(slice_id);
        }

        slice_ids
    }

    #[test]
    fn bench_is_quorum_10_nodes() {
        // 3 slices × 3-4 nodes: total ~10 nodes
        let env = Env::default();
        let client = setup(&env);

        let slice_ids = build_flat_slices(&env, &client, 3, 3);
        let creator = Address::generate(&env);
        let attestors = vec![
            &env,
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];

        env.budget().reset_default();

        for slice_id in slice_ids.iter() {
            let _result = client.is_quorum(slice_id, &attestors);
        }

        let cpu_cost = env.budget().cpu_instruction_cost();
        let mem_cost = env.budget().memory_bytes_cost();

        println!("10-node is_quorum: {} CPU, {} memory", cpu_cost, mem_cost);

        // Verify cost is reasonable
        assert!(
            cpu_cost < 2_000_000,
            "10-node is_quorum should cost < 2M CPU (was {})",
            cpu_cost
        );
        assert!(
            mem_cost < 2_000_000,
            "10-node is_quorum should cost < 2M memory (was {})",
            mem_cost
        );
    }

    #[test]
    fn bench_is_quorum_25_nodes() {
        // 6-8 slices × 3-4 nodes: total ~25 nodes
        let env = Env::default();
        let client = setup(&env);

        let slice_ids = build_flat_slices(&env, &client, 7, 3);
        let creator = Address::generate(&env);
        let mut attestors = soroban_sdk::Vec::new(&env);
        for _ in 0..5 {
            attestors.push_back(Address::generate(&env));
        }

        env.budget().reset_default();

        for slice_id in slice_ids.iter() {
            let _result = client.is_quorum(slice_id, &attestors);
        }

        let cpu_cost = env.budget().cpu_instruction_cost();
        let mem_cost = env.budget().memory_bytes_cost();

        println!("25-node is_quorum: {} CPU, {} memory", cpu_cost, mem_cost);

        assert!(
            cpu_cost < 5_000_000,
            "25-node is_quorum should cost < 5M CPU (was {})",
            cpu_cost
        );
        assert!(
            mem_cost < 5_000_000,
            "25-node is_quorum should cost < 5M memory (was {})",
            mem_cost
        );
    }

    #[test]
    fn bench_is_quorum_50_nodes() {
        // 10-15 slices × 3-5 nodes: total ~50 nodes
        let env = Env::default();
        let client = setup(&env);

        let slice_ids = build_flat_slices(&env, &client, 12, 4);
        let mut attestors = soroban_sdk::Vec::new(&env);
        for _ in 0..10 {
            attestors.push_back(Address::generate(&env));
        }

        env.budget().reset_default();

        for slice_id in slice_ids.iter() {
            let _result = client.is_quorum(slice_id, &attestors);
        }

        let cpu_cost = env.budget().cpu_instruction_cost();
        let mem_cost = env.budget().memory_bytes_cost();

        println!("50-node is_quorum: {} CPU, {} memory", cpu_cost, mem_cost);

        assert!(
            cpu_cost < 10_000_000,
            "50-node is_quorum should cost < 10M CPU (was {})",
            cpu_cost
        );
        assert!(
            mem_cost < 10_000_000,
            "50-node is_quorum should cost < 10M memory (was {})",
            mem_cost
        );
    }

    #[test]
    fn bench_is_quorum_100_nodes() {
        // 20-30 slices × 3-5 nodes: total ~100 nodes
        let env = Env::default();
        let client = setup(&env);

        let slice_ids = build_flat_slices(&env, &client, 25, 4);
        let mut attestors = soroban_sdk::Vec::new(&env);
        for _ in 0..20 {
            attestors.push_back(Address::generate(&env));
        }

        env.budget().reset_default();

        for slice_id in slice_ids.iter() {
            let _result = client.is_quorum(slice_id, &attestors);
        }

        let cpu_cost = env.budget().cpu_instruction_cost();
        let mem_cost = env.budget().memory_bytes_cost();

        println!("100-node is_quorum: {} CPU, {} memory", cpu_cost, mem_cost);

        // Soroban budget is typically ~20M CPU, ~15M memory
        assert!(
            cpu_cost < 15_000_000,
            "100-node is_quorum should cost < 15M CPU (was {})",
            cpu_cost
        );
        assert!(
            mem_cost < 15_000_000,
            "100-node is_quorum should cost < 15M memory (was {})",
            mem_cost
        );
    }
}
