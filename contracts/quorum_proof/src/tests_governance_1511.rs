/// Tests for Issue #1511: Audit governance and add event trail for repointing
/// cross-contract addresses in the quorum_proof contract.
#[cfg(test)]
mod tests_governance_1511 {
    use crate::*;
    use soroban_sdk::testutils::{Address as _, Events as _};
    use soroban_sdk::{Address, Env};

    fn setup(env: &Env) -> (QuorumProofContractClient, Address) {
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(env);
        env.mock_all_auths();
        let client = QuorumProofContractClient::new(env, &contract_id);
        client.initialize(&admin);
        (client, admin)
    }

    // ── update_admin ───────────────────────────────────────────────────────────

    #[test]
    fn test_update_admin_transfers_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let new_admin = Address::generate(&env);
        client.update_admin(&admin, &new_admin);

        // New admin should be able to call admin-only functions (e.g. pause).
        client.pause(&new_admin);
        assert!(client.is_paused());
    }

    #[test]
    fn test_update_admin_emits_admin_transferred_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let new_admin = Address::generate(&env);
        client.update_admin(&admin, &new_admin);

        let events = env.events().all();
        let found = events.iter().any(|e| {
            // Topic is a Vec<String> published as (topics, data).
            // We check the raw event vec for our topic string.
            let event_str = std::format!("{:?}", e);
            event_str.contains("AdminTransferred")
        });
        assert!(found, "AdminTransferred event not emitted");
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn test_update_admin_rejects_non_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let attacker = Address::generate(&env);
        let new_admin = Address::generate(&env);
        // attacker is not the admin — must panic
        client.update_admin(&attacker, &new_admin);
    }

    // ── update_sbt_registry_address ───────────────────────────────────────────

    #[test]
    fn test_update_sbt_registry_address_stores_new_address() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let sbt_addr = Address::generate(&env);
        client.update_sbt_registry_address(&admin, &sbt_addr);

        assert_eq!(client.get_sbt_registry_address(), Some(sbt_addr));
    }

    #[test]
    fn test_update_sbt_registry_address_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let sbt_addr = Address::generate(&env);
        client.update_sbt_registry_address(&admin, &sbt_addr);

        let events = env.events().all();
        let found = events.iter().any(|e| {
            let event_str = std::format!("{:?}", e);
            event_str.contains("ContractAddressUpdated")
        });
        assert!(found, "ContractAddressUpdated event not emitted for sbt_registry update");
    }

    #[test]
    fn test_update_sbt_registry_address_can_repoint() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let sbt_addr_v1 = Address::generate(&env);
        let sbt_addr_v2 = Address::generate(&env);

        client.update_sbt_registry_address(&admin, &sbt_addr_v1);
        assert_eq!(client.get_sbt_registry_address(), Some(sbt_addr_v1.clone()));

        client.update_sbt_registry_address(&admin, &sbt_addr_v2);
        assert_eq!(client.get_sbt_registry_address(), Some(sbt_addr_v2));
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn test_update_sbt_registry_address_rejects_non_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let attacker = Address::generate(&env);
        let sbt_addr = Address::generate(&env);
        client.update_sbt_registry_address(&attacker, &sbt_addr);
    }

    // ── update_zk_verifier_address ────────────────────────────────────────────

    #[test]
    fn test_update_zk_verifier_address_stores_new_address() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let zk_addr = Address::generate(&env);
        client.update_zk_verifier_address(&admin, &zk_addr);

        assert_eq!(client.get_zk_verifier_address(), Some(zk_addr));
    }

    #[test]
    fn test_update_zk_verifier_address_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let zk_addr = Address::generate(&env);
        client.update_zk_verifier_address(&admin, &zk_addr);

        let events = env.events().all();
        let found = events.iter().any(|e| {
            let event_str = std::format!("{:?}", e);
            event_str.contains("ContractAddressUpdated")
        });
        assert!(found, "ContractAddressUpdated event not emitted for zk_verifier update");
    }

    #[test]
    fn test_update_zk_verifier_address_can_repoint() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let zk_addr_v1 = Address::generate(&env);
        let zk_addr_v2 = Address::generate(&env);

        client.update_zk_verifier_address(&admin, &zk_addr_v1);
        assert_eq!(client.get_zk_verifier_address(), Some(zk_addr_v1.clone()));

        client.update_zk_verifier_address(&admin, &zk_addr_v2);
        assert_eq!(client.get_zk_verifier_address(), Some(zk_addr_v2));
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn test_update_zk_verifier_address_rejects_non_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let attacker = Address::generate(&env);
        let zk_addr = Address::generate(&env);
        client.update_zk_verifier_address(&attacker, &zk_addr);
    }

    // ── get_* helpers return None before first set ─────────────────────────────

    #[test]
    fn test_get_sbt_registry_address_returns_none_before_set() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        assert_eq!(client.get_sbt_registry_address(), None);
    }

    #[test]
    fn test_get_zk_verifier_address_returns_none_before_set() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        assert_eq!(client.get_zk_verifier_address(), None);
    }
}
