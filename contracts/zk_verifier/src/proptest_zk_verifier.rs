/// Property-based tests for the zk_verifier stub (#1474).
///
/// The README notes that `verify_claim` is a non-functional stub that
/// "accepts any non-empty byte string."  These properties lock down the
/// documented stub behaviour precisely so that a future real-verifier swap
/// (Groth16/PLONK pairing checks) will cause these tests to start failing
/// loudly — acting as a tripwire against an incomplete migration.
///
/// Properties asserted:
///   1. Any non-empty proof → `verify_claim` returns `true`  (stub pass-all)
///   2. An empty proof      → `verify_claim` returns `false` (always rejected)
///   3. The admin-gate is enforced regardless of proof content
///   4. The stub's empty/non-empty behaviour is independent of `ClaimType`
///
/// # Tripwire note
/// Properties 1 and 4 will START FAILING once a real cryptographic verifier
/// replaces the stub, because a random byte string is (with overwhelming
/// probability) not a valid proof for any real circuit.  That is intentional:
/// the test suite is designed to catch an incomplete migration.
#[cfg(test)]
mod proptest_zk_verifier {
    use crate::{ClaimType, ZkVerifierContract, ZkVerifierContractClient};
    use proptest::prelude::*;
    use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env};

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn setup(env: &Env) -> (ZkVerifierContractClient<'static>, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        // Register the deterministic VK hash expected by verify_claim.
        let vk_hash = BytesN::from_array(env, &[1u8; 32]);
        client.set_verifying_key(&admin, &vk_hash);
        (client, admin)
    }

    /// Converts a raw `Vec<u8>` to a Soroban `Bytes`.
    fn to_bytes(env: &Env, v: &[u8]) -> Bytes {
        Bytes::from_slice(env, v)
    }

    /// All five `ClaimType` variants as a proptest strategy.
    fn arb_claim_type() -> impl Strategy<Value = ClaimType> {
        prop_oneof![
            Just(ClaimType::HasDegree),
            Just(ClaimType::HasLicense),
            Just(ClaimType::HasEmploymentHistory),
            Just(ClaimType::HasCertification),
            Just(ClaimType::HasResearchPublication),
        ]
    }

    // ── Properties ──────────────────────────────────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(30))]

        /// STUB BEHAVIOUR: any non-empty proof passes verify_claim.
        ///
        /// TRIPWIRE: this property will fail once real cryptographic
        /// verification replaces the stub, because an arbitrary byte string
        /// is not a valid proof for any real circuit.
        #[test]
        fn prop_non_empty_proof_passes(
            proof_bytes in proptest::collection::vec(any::<u8>(), 1..=512),
        ) {
            let env = Env::default();
            let (client, admin) = setup(&env);
            let proof = to_bytes(&env, &proof_bytes);

            let result = client.verify_claim(
                &admin,
                &Address::generate(&env), // quorum_proof_id (ignored by stub)
                &1u64,
                &ClaimType::HasDegree,
                &proof,
            );

            prop_assert!(
                result,
                "STUB: any non-empty proof must return true \
                 (this assertion is a tripwire — it will fail when a real \
                 verifier replaces the stub)"
            );
        }

        /// STUB BEHAVIOUR: an empty proof is always rejected.
        ///
        /// This invariant MUST hold for both the stub and any real verifier.
        #[test]
        fn prop_empty_proof_always_rejected(
            // Vary the credential_id and claim type to confirm the rejection
            // is unconditional regardless of other parameters.
            credential_id in 1u64..=10_000,
            claim_type in arb_claim_type(),
        ) {
            let env = Env::default();
            let (client, admin) = setup(&env);
            let empty = to_bytes(&env, &[]);

            let result = client.verify_claim(
                &admin,
                &Address::generate(&env),
                &credential_id,
                &claim_type,
                &empty,
            );

            prop_assert!(
                !result,
                "empty proof must always return false (credential_id={credential_id}, \
                 claim_type={claim_type:?})"
            );
        }

        /// ADMIN GATE: verify_claim requires admin authorisation regardless
        /// of proof content or claim type.  A non-admin caller must panic.
        #[test]
        fn prop_admin_gate_independent_of_proof_content(
            proof_bytes in proptest::collection::vec(any::<u8>(), 1..=256),
            claim_type in arb_claim_type(),
        ) {
            let env = Env::default();
            // Do NOT call mock_all_auths so that auth failures propagate.
            let id = env.register_contract(None, ZkVerifierContract);
            let client = ZkVerifierContractClient::new(&env, &id);

            // Initialise using a mocked-auth setup just for the init call.
            let admin = {
                env.mock_all_auths();
                let a = Address::generate(&env);
                client.initialize(&a);
                let vk_hash = BytesN::from_array(&env, &[1u8; 32]);
                client.set_verifying_key(&a, &vk_hash);
                a
            };
            // From here on auth is no longer mocked.
            env.set_auths(&[]);

            let attacker = Address::generate(&env);
            let proof = to_bytes(&env, &proof_bytes);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.verify_claim(
                    &attacker,
                    &Address::generate(&env),
                    &1u64,
                    &claim_type,
                    &proof,
                );
            }));

            prop_assert!(
                result.is_err(),
                "verify_claim with a non-admin caller must panic regardless \
                 of proof content (claim_type={claim_type:?})"
            );

            // Confirm the real admin can still call through without panic
            // (proof result may be true or false; we only care auth succeeds).
            env.mock_all_auths();
            let _ = client.verify_claim(
                &admin,
                &Address::generate(&env),
                &1u64,
                &claim_type,
                &proof,
            );
        }

        /// CLAIM TYPE INDEPENDENCE: the stub's non-empty/empty distinction
        /// is invariant across all ClaimType variants.
        #[test]
        fn prop_stub_behaviour_independent_of_claim_type(
            proof_len in 1usize..=128,
            claim_type in arb_claim_type(),
        ) {
            let env = Env::default();
            let (client, admin) = setup(&env);

            let proof_bytes: std::vec::Vec<u8> = (0..proof_len).map(|i| (i as u8) + 1).collect();
            let proof = to_bytes(&env, &proof_bytes);

            let result = client.verify_claim(
                &admin,
                &Address::generate(&env),
                &1u64,
                &claim_type,
                &proof,
            );

            // STUB: result should be true for non-empty input regardless of claim type.
            // TRIPWIRE: will fail once real verification is wired in.
            prop_assert!(
                result,
                "stub should return true for any non-empty proof regardless of \
                 ClaimType; claim_type={claim_type:?}, proof_len={proof_len}"
            );
        }
    }
}
