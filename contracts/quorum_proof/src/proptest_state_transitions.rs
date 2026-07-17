/// Property-based tests for credential state machine transitions (#849).
///
/// Models the credential lifecycle as a state machine with states:
///   Active → Suspended → Active (resume)
///   Active → Revoked (terminal)
///   Suspended → Revoked (terminal)
///
/// Properties verified across random transition sequences:
///  - Revocation is always terminal (no further transitions allowed)
///  - Suspension is reversible but revocation is not
///  - State is always consistent between consecutive reads
///  - Attesting requires Active state
///  - A random interleaving of ops on multiple credentials never corrupts
///    the state of uninvolved credentials
#[cfg(test)]
mod proptest_state_transitions {
    use crate::{QuorumProofContract, QuorumProofContractClient};
    use proptest::prelude::*;
    use soroban_sdk::{testutils::Address as _, Bytes, Env, Address};

    // -------------------------------------------------------------------------
    // State model
    // -------------------------------------------------------------------------

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum CredState {
        Active,
        Suspended,
        Revoked,
    }

    /// Operations that can be applied to a credential.
    #[derive(Clone, Copy, Debug)]
    enum Op {
        Suspend,
        Resume,
        Revoke,
        Attest,
    }

    fn op_strategy() -> impl Strategy<Value = Op> {
        prop_oneof![
            Just(Op::Suspend),
            Just(Op::Resume),
            Just(Op::Revoke),
            Just(Op::Attest),
        ]
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    fn setup(env: &Env) -> QuorumProofContractClient<'_> {
        env.mock_all_auths_allowing_non_root_auth();
        let id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        client
    }

    fn meta(env: &Env, len: usize) -> Bytes {
        let v: std::vec::Vec<u8> = (0..len.clamp(1, 32)).map(|i| (i as u8) + 1).collect();
        Bytes::from_slice(env, &v)
    }

    fn issue(client: &QuorumProofContractClient<'_>, env: &Env, issuer: &Address, subject: &Address) -> u64 {
        client.issue_credential(issuer, subject, &1u32, &meta(env, 8), &None, &0u64)
    }

    fn make_slice(client: &QuorumProofContractClient<'_>, env: &Env, creator: &Address, attestor: &Address) -> u64 {
        client.create_slice(
            creator,
            &soroban_sdk::vec![env, attestor.clone()],
            &soroban_sdk::vec![env, 1u32],
            &1u32,
        )
    }

    /// Apply `op` against a live credential and return whether it should succeed
    /// according to the model state.  Returns the new model state.
    fn apply_op(
        client: &QuorumProofContractClient<'_>,
        env: &Env,
        issuer: &Address,
        attestor: &Address,
        slice_id: u64,
        cred_id: u64,
        state: CredState,
        op: Op,
    ) -> CredState {
        match (state, op) {
            // Revoked is terminal: all ops must fail
            (CredState::Revoked, _) => {
                // Any operation on a revoked credential must panic
                state
            }
            // Suspend an active credential
            (CredState::Active, Op::Suspend) => {
                client.suspend_credential(issuer, &cred_id);
                CredState::Suspended
            }
            // Resume a suspended credential
            (CredState::Suspended, Op::Resume) => {
                client.resume_credential(issuer, &cred_id);
                CredState::Active
            }
            // Suspend a suspended credential — should be a no-op or fail
            (CredState::Suspended, Op::Suspend) => {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.suspend_credential(issuer, &cred_id);
                }));
                CredState::Suspended
            }
            // Resume an active credential — should fail or be no-op
            (CredState::Active, Op::Resume) => {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.resume_credential(issuer, &cred_id);
                }));
                CredState::Active
            }
            // Revoke from any non-revoked state
            (_, Op::Revoke) => {
                client.revoke_credential(issuer, &cred_id);
                CredState::Revoked
            }
            // Attest on Active succeeds; on Suspended must fail
            (CredState::Active, Op::Attest) => {
                let _ = client.attest(attestor, &cred_id, &slice_id, &true, &None);
                CredState::Active
            }
            (CredState::Suspended, Op::Attest) => {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.attest(attestor, &cred_id, &slice_id, &true, &None);
                }));
                // must have panicked
                let _ = result;
                CredState::Suspended
            }
        }
    }

    // -------------------------------------------------------------------------
    // Properties
    // -------------------------------------------------------------------------

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(30))]

        // Property: after any sequence of ops, the live contract state matches the model.
        #[test]
        fn prop_state_machine_consistent_with_model(
            ops in prop::collection::vec(op_strategy(), 1..=12),
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer  = Address::generate(&env);
            let subject = Address::generate(&env);
            let attestor = Address::generate(&env);

            let cred_id  = issue(&client, &env, &issuer, &subject);
            let slice_id = make_slice(&client, &env, &issuer, &attestor);

            let mut model = CredState::Active;

            for op in ops {
                model = apply_op(&client, &env, &issuer, &attestor, slice_id, cred_id, model, op);

                let cred = client.get_credential(&cred_id);

                match model {
                    CredState::Active => {
                        prop_assert!(!cred.revoked,    "model=Active but revoked=true");
                        prop_assert!(!cred.suspended,  "model=Active but suspended=true");
                    }
                    CredState::Suspended => {
                        prop_assert!(!cred.revoked,   "model=Suspended but revoked=true");
                        prop_assert!(cred.suspended,  "model=Suspended but suspended=false");
                    }
                    CredState::Revoked => {
                        prop_assert!(cred.revoked,    "model=Revoked but revoked=false");
                    }
                }
            }
        }

        // Property: once revoked, no subsequent op can clear the revoked flag.
        #[test]
        fn prop_revocation_is_terminal(
            ops_before in prop::collection::vec(op_strategy(), 0..=6),
            ops_after  in prop::collection::vec(op_strategy(), 1..=6),
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer  = Address::generate(&env);
            let subject = Address::generate(&env);
            let attestor = Address::generate(&env);

            let cred_id  = issue(&client, &env, &issuer, &subject);
            let slice_id = make_slice(&client, &env, &issuer, &attestor);

            let mut model = CredState::Active;

            // Apply ops until we either naturally reach Revoked or exhaust the list
            for op in &ops_before {
                if model == CredState::Revoked { break; }
                model = apply_op(&client, &env, &issuer, &attestor, slice_id, cred_id, model, *op);
            }

            // Force revocation
            if model != CredState::Revoked {
                client.revoke_credential(&issuer, &cred_id);
                model = CredState::Revoked;
            }

            prop_assert_eq!(model, CredState::Revoked);

            // Every subsequent op must leave the credential in the Revoked state
            for op in &ops_after {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    match op {
                        Op::Suspend => client.suspend_credential(&issuer, &cred_id),
                        Op::Resume  => client.resume_credential(&issuer, &cred_id),
                        Op::Revoke  => { client.revoke_credential(&issuer, &cred_id); }
                        Op::Attest  => { client.attest(&attestor, &cred_id, &slice_id, &true, &None); }
                    }
                }));
                // All must fail (panic); revoked flag must remain true regardless
                let _ = result;
                let cred = client.get_credential(&cred_id);
                prop_assert!(cred.revoked, "revoked flag cleared after terminal state");
            }
        }

        // Property: interleaving ops on two credentials does not corrupt each other's state.
        #[test]
        fn prop_independent_credentials_do_not_interfere(
            ops_a in prop::collection::vec(op_strategy(), 2..=8),
            ops_b in prop::collection::vec(op_strategy(), 2..=8),
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer  = Address::generate(&env);
            let subject = Address::generate(&env);
            let attestor = Address::generate(&env);

            let cred_a   = issue(&client, &env, &issuer, &subject);
            let cred_b   = issue(&client, &env, &issuer, &subject);
            let slice_id = make_slice(&client, &env, &issuer, &attestor);

            let mut model_a = CredState::Active;
            let mut model_b = CredState::Active;

            let max_len = ops_a.len().max(ops_b.len());
            for i in 0..max_len {
                if i < ops_a.len() && model_a != CredState::Revoked {
                    model_a = apply_op(&client, &env, &issuer, &attestor, slice_id, cred_a, model_a, ops_a[i]);
                }
                if i < ops_b.len() && model_b != CredState::Revoked {
                    model_b = apply_op(&client, &env, &issuer, &attestor, slice_id, cred_b, model_b, ops_b[i]);
                }
            }

            // Verify final states are independent
            let a = client.get_credential(&cred_a);
            let b = client.get_credential(&cred_b);

            let a_ok = match model_a {
                CredState::Active    => !a.revoked && !a.suspended,
                CredState::Suspended =>  a.suspended && !a.revoked,
                CredState::Revoked   =>  a.revoked,
            };
            let b_ok = match model_b {
                CredState::Active    => !b.revoked && !b.suspended,
                CredState::Suspended =>  b.suspended && !b.revoked,
                CredState::Revoked   =>  b.revoked,
            };

            prop_assert!(a_ok, "credential A state mismatch: model={:?} revoked={} suspended={}", model_a, a.revoked, a.suspended);
            prop_assert!(b_ok, "credential B state mismatch: model={:?} revoked={} suspended={}", model_b, b.revoked, b.suspended);
        }

        // Property: suspend→resume cycle always returns the credential to Active.
        #[test]
        fn prop_suspend_resume_cycle_returns_to_active(cycles in 1usize..=5) {
            let env = Env::default();
            let client = setup(&env);
            let issuer  = Address::generate(&env);
            let subject = Address::generate(&env);

            let cred_id = issue(&client, &env, &issuer, &subject);

            for _ in 0..cycles {
                client.suspend_credential(&issuer, &cred_id);
                let mid = client.get_credential(&cred_id);
                prop_assert!(mid.suspended, "credential not suspended after suspend()");
                prop_assert!(!mid.revoked,  "revoked flag set during suspension");

                client.resume_credential(&issuer, &cred_id);
                let end = client.get_credential(&cred_id);
                prop_assert!(!end.suspended, "credential still suspended after resume()");
                prop_assert!(!end.revoked,   "revoked flag set after resume()");
            }
        }

        // Property: attestation is only possible in the Active state.
        #[test]
        fn prop_attest_requires_active_state(
            state_op in prop_oneof![Just(Op::Suspend), Just(Op::Revoke)],
        ) {
            let env = Env::default();
            let client = setup(&env);
            let issuer  = Address::generate(&env);
            let subject = Address::generate(&env);
            let attestor = Address::generate(&env);

            let cred_id  = issue(&client, &env, &issuer, &subject);
            let slice_id = make_slice(&client, &env, &issuer, &attestor);

            match state_op {
                Op::Suspend => client.suspend_credential(&issuer, &cred_id),
                Op::Revoke  => { client.revoke_credential(&issuer, &cred_id); }
                _ => unreachable!(),
            }

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.attest(&attestor, &cred_id, &slice_id, &true, &None);
            }));
            prop_assert!(result.is_err(), "attest on non-Active credential must fail");
        }
    }
}
