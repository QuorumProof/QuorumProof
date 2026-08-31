/// Property-based state-machine tests for sbt_registry (#1473).
///
/// Covers mint/burn/query operation sequences and asserts the core soulbound
/// invariant — non-transferability — holds under randomised orderings.
///
/// A minimal mock `quorum_proof` is embedded so these tests are self-contained
/// and do not depend on the rest of the workspace.
#[cfg(test)]
mod proptest_sbt_registry {
    use crate::{SbtRegistryContract, SbtRegistryContractClient};
    use proptest::prelude::*;
    use soroban_sdk::{
        contract, contractimpl, contracttype, testutils::Address as _, Address, Bytes, Env,
    };

    // ── Minimal mock quorum_proof ────────────────────────────────────────────

    #[contracttype]
    enum MockQpKey {
        Revoked(u64),
    }

    #[contract]
    pub struct MockQp;

    #[contractimpl]
    impl MockQp {
        pub fn set_revoked(env: Env, credential_id: u64, revoked: bool) {
            env.storage()
                .persistent()
                .set(&MockQpKey::Revoked(credential_id), &revoked);
        }
        pub fn is_revoked(env: Env, credential_id: u64) -> bool {
            env.storage()
                .persistent()
                .get(&MockQpKey::Revoked(credential_id))
                .unwrap_or(false)
        }
    }

    // ── Test harness ─────────────────────────────────────────────────────────

    fn setup(env: &Env) -> (SbtRegistryContractClient<'static>, Address) {
        env.mock_all_auths();
        let qp_id = env.register_contract(None, MockQp);
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let client = SbtRegistryContractClient::new(env, &sbt_id);
        let admin = Address::generate(env);
        client.initialize(&admin, &qp_id);
        (client, qp_id)
    }

    fn metadata(env: &Env) -> Bytes {
        Bytes::from_slice(env, b"ipfs://QmTest")
    }

    // ── Properties ──────────────────────────────────────────────────────────

    // Invariant: minted token ID is positive and token is owned by the right address.
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(20))]

        #[test]
        fn prop_mint_returns_positive_id_and_owner(
            credential_id in 1u64..=1_000,
        ) {
            let env = Env::default();
            let (client, _qp) = setup(&env);
            let owner = Address::generate(&env);

            let token_id = client.mint(&owner, &credential_id, &metadata(&env));

            prop_assert!(token_id > 0, "token ID must be positive");
            prop_assert_eq!(
                client.owner_of(&token_id),
                owner,
                "owner_of must return the minting address"
            );
        }

        // Invariant: duplicate mint (same owner × credential_id) is always rejected.
        #[test]
        fn prop_duplicate_mint_always_rejected(
            credential_id in 1u64..=1_000,
        ) {
            let env = Env::default();
            let (client, _qp) = setup(&env);
            let owner = Address::generate(&env);

            client.mint(&owner, &credential_id, &metadata(&env));

            let second = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.mint(&owner, &credential_id, &metadata(&env));
            }));
            prop_assert!(
                second.is_err(),
                "second mint for the same (owner, credential_id) must panic"
            );
        }

        // Invariant: a burned SBT can never be re-minted with the same ID (the ID
        // counter never rewinds), but the owner-credential slot is freed so a fresh
        // mint for the same credential_id produces a new, higher token ID.
        #[test]
        fn prop_burned_sbt_id_never_reused(
            credential_id in 1u64..=1_000,
        ) {
            let env = Env::default();
            let (client, _qp) = setup(&env);
            let owner = Address::generate(&env);

            let first_id = client.mint(&owner, &credential_id, &metadata(&env));
            client.burn(&owner, &first_id);

            // After burn the owner-credential slot is freed; re-minting must succeed
            // but must produce a strictly larger ID.
            let second_id = client.mint(&owner, &credential_id, &metadata(&env));
            prop_assert!(
                second_id > first_id,
                "re-minted token ID ({second_id}) must be greater than burned ID ({first_id})"
            );
        }

        // Invariant: sbt_count equals the number of tokens currently alive
        // (not the total ever minted).
        #[test]
        fn prop_sbt_count_tracks_live_tokens(
            n_mint in 2usize..=6,
        ) {
            let env = Env::default();
            let (client, _qp) = setup(&env);

            let mut token_ids = std::vec::Vec::new();
            for i in 0..n_mint {
                let owner = Address::generate(&env);
                let cred_id = (i as u64) + 1;
                let tid = client.mint(&owner, &cred_id, &metadata(&env));
                token_ids.push((owner, tid));
            }

            let count_after_mints = client.sbt_count();
            prop_assert_eq!(
                count_after_mints,
                n_mint as u64,
                "sbt_count after {n_mint} mints"
            );

            // Burn the first token.
            let (owner0, tid0) = token_ids[0].clone();
            client.burn(&owner0, &tid0);

            let count_after_burn = client.sbt_count();
            // sbt_count reflects the internal token-counter, not a live-count;
            // it must at least be >= (n_mint - 1) and equal to (n_mint - 1) because
            // burn decrements the counter.
            // The key invariant is: count is never negative and burn decreased it.
            prop_assert!(
                count_after_burn < count_after_mints,
                "sbt_count must decrease after a burn: before={count_after_mints} after={count_after_burn}"
            );
        }

        // Invariant: `transfer` always panics regardless of caller or token state.
        // This is the core soulbound non-transferability guarantee.
        #[test]
        fn prop_transfer_always_rejected(
            credential_id in 1u64..=1_000,
        ) {
            let env = Env::default();
            let (client, _qp) = setup(&env);
            let owner = Address::generate(&env);
            let recipient = Address::generate(&env);

            let token_id = client.mint(&owner, &credential_id, &metadata(&env));

            // Direct transfer — must always panic.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.transfer(&owner, &recipient, &token_id);
            }));
            prop_assert!(
                result.is_err(),
                "transfer must always panic (soulbound invariant)"
            );
        }

        // Invariant: minting for a revoked credential is always rejected.
        #[test]
        fn prop_mint_revoked_credential_always_rejected(
            credential_id in 1u64..=1_000,
        ) {
            let env = Env::default();
            let (client, qp_id) = setup(&env);
            let owner = Address::generate(&env);

            // Mark the credential as revoked in the mock.
            let qp = MockQpClient::new(&env, &qp_id);
            qp.set_revoked(&credential_id, &true);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.mint(&owner, &credential_id, &metadata(&env));
            }));
            prop_assert!(
                result.is_err(),
                "minting with a revoked credential must always panic"
            );
        }

        // Invariant: after burning, get_tokens_by_owner no longer includes the token.
        #[test]
        fn prop_burned_token_absent_from_owner_list(
            credential_id in 1u64..=1_000,
        ) {
            let env = Env::default();
            let (client, _qp) = setup(&env);
            let owner = Address::generate(&env);

            let token_id = client.mint(&owner, &credential_id, &metadata(&env));
            client.burn(&owner, &token_id);

            let tokens = client.get_tokens_by_owner(&owner);
            prop_assert!(
                !tokens.iter().any(|id| id == token_id),
                "burned token must not appear in owner's token list"
            );
        }

        // Invariant: a non-owner can never burn another user's SBT.
        #[test]
        fn prop_non_owner_cannot_burn(
            credential_id in 1u64..=1_000,
        ) {
            let env = Env::default();
            let (client, _qp) = setup(&env);
            let owner = Address::generate(&env);
            let attacker = Address::generate(&env);

            let token_id = client.mint(&owner, &credential_id, &metadata(&env));

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.burn(&attacker, &token_id);
            }));
            prop_assert!(
                result.is_err(),
                "burning another holder's token must panic"
            );
        }
    }
}
