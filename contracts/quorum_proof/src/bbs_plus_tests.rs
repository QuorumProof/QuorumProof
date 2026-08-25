//! Tests for BBS+ feature implementations (Issues #1287, #1288, #1289, #1290)

#[cfg(test)]
mod tests_bbs_plus {
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{Address, Bytes, Env, Vec};

    use crate::bbs_plus_features::{
        add_to_revocation_accumulator, batch_check_disclosure, batch_verify_bbs_signatures,
        bbs_cache_key, cache_bbs_signature, check_disclosure_permitted,
        create_non_revocation_proof, get_attribute_privacy, get_bbs_issuer_key_history,
        get_bbs_issuer_key_info, get_bbs_issuer_key_version, get_bbs_precomputed_generators,
        get_cached_bbs_signature, get_revocation_accumulator, rotate_issuer_key,
        set_attribute_privacy, store_bbs_precomputed_generators, verify_non_revocation,
        BbsBatchVerifyItem, PrivacyLevel,
    };
    use crate::QuorumProofContract;

    // ─────────────────────────────────────────────────────────────────────────
    // Issue #1287 – Revocation Accumulator
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_add_to_revocation_accumulator_initializes() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let caller = Address::generate(&env);
            let acc_bytes = Bytes::from_slice(&env, b"accumulator-point-v1");

            add_to_revocation_accumulator(&env, caller, 1u64, acc_bytes.clone());

            let state = get_revocation_accumulator(&env).expect("accumulator should be stored");
            assert_eq!(state.epoch, 1u64);
            assert_eq!(state.accumulator_bytes, acc_bytes);
        });
    }

    #[test]
    fn test_add_to_revocation_accumulator_increments_epoch() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let caller = Address::generate(&env);
        let v1 = Bytes::from_slice(&env, b"acc-v1");
        let v2 = Bytes::from_slice(&env, b"acc-v2");

        // Each call is its own top-level invocation, matching how these
        // functions are actually invoked in production (one auth check per
        // call frame).
        env.as_contract(&contract_id, || {
            add_to_revocation_accumulator(&env, caller.clone(), 1u64, v1);
        });
        env.as_contract(&contract_id, || {
            add_to_revocation_accumulator(&env, caller, 2u64, v2.clone());
        });

        env.as_contract(&contract_id, || {
            let state = get_revocation_accumulator(&env).unwrap();
            assert_eq!(state.epoch, 2u64);
            assert_eq!(state.accumulator_bytes, v2);
        });
    }

    #[test]
    fn test_create_non_revocation_proof_stores_record() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let admin = Address::generate(&env);
            let holder = Address::generate(&env);
            let acc_bytes = Bytes::from_slice(&env, b"acc-point");
            let proof = Bytes::from_slice(&env, b"non-revocation-proof-bytes");

            add_to_revocation_accumulator(&env, admin, 42u64, acc_bytes);
            create_non_revocation_proof(&env, holder, 42u64, proof.clone());

            // verify_non_revocation should return true since epoch matches.
            assert!(verify_non_revocation(&env, 42u64));
        });
    }

    #[test]
    fn test_verify_non_revocation_fails_when_no_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let caller = Address::generate(&env);
            let acc_bytes = Bytes::from_slice(&env, b"acc-point");
            add_to_revocation_accumulator(&env, caller, 99u64, acc_bytes);

            // No proof stored for credential 99 — should be false.
            assert!(!verify_non_revocation(&env, 99u64));
        });
    }

    #[test]
    fn test_verify_non_revocation_fails_stale_epoch() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(&env);
        let holder = Address::generate(&env);

        // Epoch 1: store a proof for credential 5.
        let v1 = Bytes::from_slice(&env, b"acc-v1");
        env.as_contract(&contract_id, || {
            add_to_revocation_accumulator(&env, admin.clone(), 5u64, v1);
        });
        let proof = Bytes::from_slice(&env, b"proof-for-epoch-1");
        env.as_contract(&contract_id, || {
            create_non_revocation_proof(&env, holder, 5u64, proof);
        });

        // Epoch 2: accumulator is updated (revocation event).
        let v2 = Bytes::from_slice(&env, b"acc-v2");
        env.as_contract(&contract_id, || {
            add_to_revocation_accumulator(&env, admin, 5u64, v2);
        });

        // The stored proof is now from epoch 1 but current is epoch 2 → stale.
        env.as_contract(&contract_id, || {
            assert!(!verify_non_revocation(&env, 5u64));
        });
    }

    #[test]
    fn test_verify_non_revocation_fails_no_accumulator() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            // No accumulator set at all.
            assert!(!verify_non_revocation(&env, 1u64));
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Issue #1288 – Performance Optimization / Memoization
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_cache_bbs_signature_stores_and_retrieves() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let vk = Bytes::from_slice(&env, b"vk-bytes");
            let msg = Bytes::from_slice(&env, b"msg-bytes");
            let sig = Bytes::from_slice(&env, b"sig-bytes");

            cache_bbs_signature(&env, vk.clone(), msg.clone(), sig.clone(), true);

            let cached = get_cached_bbs_signature(&env, &vk, &msg, &sig)
                .expect("cache hit expected");
            assert!(cached.is_valid);
        });
    }

    #[test]
    fn test_cache_bbs_signature_miss_returns_none() {
        let env = Env::default();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let vk = Bytes::from_slice(&env, b"vk");
            let msg = Bytes::from_slice(&env, b"msg");
            let sig = Bytes::from_slice(&env, b"sig");

            // Nothing cached yet.
            let result = get_cached_bbs_signature(&env, &vk, &msg, &sig);
            assert!(result.is_none());
        });
    }

    #[test]
    fn test_cache_key_differs_on_different_inputs() {
        let env = Env::default();

        let vk1 = Bytes::from_slice(&env, b"vk1");
        let vk2 = Bytes::from_slice(&env, b"vk2");
        let msg = Bytes::from_slice(&env, b"msg");
        let sig = Bytes::from_slice(&env, b"sig");

        let key1 = bbs_cache_key(&env, &vk1, &msg, &sig);
        let key2 = bbs_cache_key(&env, &vk2, &msg, &sig);
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_cache_key_is_deterministic() {
        let env = Env::default();

        let vk = Bytes::from_slice(&env, b"vk");
        let msg = Bytes::from_slice(&env, b"msg");
        let sig = Bytes::from_slice(&env, b"sig");

        let k1 = bbs_cache_key(&env, &vk, &msg, &sig);
        let k2 = bbs_cache_key(&env, &vk, &msg, &sig);
        assert_eq!(k1, k2);
    }

    #[test]
    fn test_batch_verify_returns_cached_results() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let vk = Bytes::from_slice(&env, b"vk");
            let msg = Bytes::from_slice(&env, b"msg");
            let sig = Bytes::from_slice(&env, b"sig");

            // Pre-populate the cache.
            cache_bbs_signature(&env, vk.clone(), msg.clone(), sig.clone(), true);

            let mut items: Vec<BbsBatchVerifyItem> = Vec::new(&env);
            items.push_back(BbsBatchVerifyItem {
                credential_id: 7u64,
                verifying_key_bytes: vk,
                message_bytes: msg,
                signature_bytes: sig,
            });

            let results = batch_verify_bbs_signatures(&env, items);
            assert_eq!(results.len(), 1u32);
            let r = results.get(0).unwrap();
            assert_eq!(r.credential_id, 7u64);
            assert!(r.is_valid);
        });
    }

    #[test]
    fn test_batch_verify_returns_false_for_cache_miss() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let mut items: Vec<BbsBatchVerifyItem> = Vec::new(&env);
            items.push_back(BbsBatchVerifyItem {
                credential_id: 99u64,
                verifying_key_bytes: Bytes::from_slice(&env, b"unknown-vk"),
                message_bytes: Bytes::from_slice(&env, b"unknown-msg"),
                signature_bytes: Bytes::from_slice(&env, b"unknown-sig"),
            });

            let results = batch_verify_bbs_signatures(&env, items);
            let r = results.get(0).unwrap();
            assert!(!r.is_valid);
        });
    }

    #[test]
    fn test_precomputed_generators_round_trip() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let issuer = Address::generate(&env);
            let vk_bytes = Bytes::from_slice(&env, b"W||Q1||H0||H1||H2");

            store_bbs_precomputed_generators(&env, issuer.clone(), vk_bytes.clone());

            let retrieved = get_bbs_precomputed_generators(&env, issuer)
                .expect("precomputed generators should be stored");
            assert_eq!(retrieved.verifying_key_bytes, vk_bytes);
        });
    }

    #[test]
    fn test_precomputed_generators_missing_returns_none() {
        let env = Env::default();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let issuer = Address::generate(&env);
            let result = get_bbs_precomputed_generators(&env, issuer);
            assert!(result.is_none());
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Issue #1289 – Key Rotation
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_rotate_issuer_key_first_registration() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let admin = Address::generate(&env);
            let issuer = Address::generate(&env);
            let key_v1 = Bytes::from_slice(&env, b"issuer-bbs-public-key-v1");

            rotate_issuer_key(&env, admin, issuer.clone(), key_v1.clone());

            let info = get_bbs_issuer_key_info(&env, issuer.clone());
            assert_eq!(info.current_version, 1u32);
            assert_eq!(info.total_versions, 1u32);

            let record = get_bbs_issuer_key_version(&env, issuer, 1u32).unwrap();
            assert_eq!(record.version, 1u32);
            assert_eq!(record.verifying_key_bytes, key_v1);
            assert_eq!(record.superseded_at, 0u64); // still active
            assert!(!record.revoked);
        });
    }

    #[test]
    fn test_rotate_issuer_key_supersedes_previous() {
        let env = Env::default();
        env.mock_all_auths();
        // A rotation's `superseded_at` is stamped with the ledger timestamp,
        // and 0 doubles as the "not yet superseded" sentinel; keep the clock
        // off zero so superseding v1 is observable.
        env.ledger().with_mut(|li| li.timestamp = 1000);
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);

        let key_v1 = Bytes::from_slice(&env, b"bbs-key-v1");
        let key_v2 = Bytes::from_slice(&env, b"bbs-key-v2");

        env.as_contract(&contract_id, || {
            rotate_issuer_key(&env, admin.clone(), issuer.clone(), key_v1);
        });
        env.as_contract(&contract_id, || {
            rotate_issuer_key(&env, admin, issuer.clone(), key_v2.clone());
        });

        env.as_contract(&contract_id, || {
            let info = get_bbs_issuer_key_info(&env, issuer.clone());
            assert_eq!(info.current_version, 2u32);
            assert_eq!(info.total_versions, 2u32);

            // v1 should now be superseded.
            let v1 = get_bbs_issuer_key_version(&env, issuer.clone(), 1u32).unwrap();
            assert!(v1.superseded_at > 0u64, "v1 must be superseded after rotation");

            // v2 should still be active.
            let v2 = get_bbs_issuer_key_version(&env, issuer, 2u32).unwrap();
            assert_eq!(v2.superseded_at, 0u64, "v2 must not be superseded yet");
            assert_eq!(v2.verifying_key_bytes, key_v2);
        });
    }

    #[test]
    fn test_key_version_history_preserves_all_versions() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);

        for i in 1u8..=3u8 {
            let key = Bytes::from_slice(&env, &[i; 48]);
            let admin = admin.clone();
            let issuer = issuer.clone();
            env.as_contract(&contract_id, || {
                rotate_issuer_key(&env, admin, issuer, key);
            });
        }

        env.as_contract(&contract_id, || {
            let history = get_bbs_issuer_key_history(&env, issuer);
            assert_eq!(history.len(), 3u32);
        });
    }

    #[test]
    fn test_get_nonexistent_key_version_returns_none() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let issuer = Address::generate(&env);
            let result = get_bbs_issuer_key_version(&env, issuer, 99u32);
            assert!(result.is_none());
        });
    }

    #[test]
    fn test_issuer_key_info_empty_issuer() {
        let env = Env::default();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let issuer = Address::generate(&env);
            let info = get_bbs_issuer_key_info(&env, issuer);
            assert_eq!(info.current_version, 0u32);
            assert_eq!(info.total_versions, 0u32);
            assert_eq!(info.last_rotated_at, 0u64);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Issue #1290 – Attribute Privacy Controls
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_set_attribute_privacy_and_retrieve() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let admin = Address::generate(&env);
            let attr = Bytes::from_slice(&env, b"salary");

            set_attribute_privacy(&env, admin, 1u32, attr.clone(), PrivacyLevel::Confidential);

            let policy = get_attribute_privacy(&env, 1u32, attr);
            assert_eq!(policy.sensitivity, PrivacyLevel::Confidential);
            assert_eq!(policy.credential_type, 1u32);
        });
    }

    #[test]
    fn test_default_attribute_privacy_is_public() {
        let env = Env::default();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let attr = Bytes::from_slice(&env, b"graduation_date");
            let policy = get_attribute_privacy(&env, 1u32, attr);
            assert_eq!(policy.sensitivity, PrivacyLevel::Public);
        });
    }

    #[test]
    fn test_check_disclosure_public_always_permitted() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let admin = Address::generate(&env);
            let attr = Bytes::from_slice(&env, b"degree_type");
            set_attribute_privacy(&env, admin, 2u32, attr.clone(), PrivacyLevel::Public);

            let result = check_disclosure_permitted(&env, 2u32, attr, false);
            assert!(result.disclosure_permitted);
        });
    }

    #[test]
    fn test_check_disclosure_internal_requires_permission() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let admin = Address::generate(&env);
            let attr = Bytes::from_slice(&env, b"employer_ref");
            set_attribute_privacy(&env, admin, 3u32, attr.clone(), PrivacyLevel::Internal);

            let unpermissioned = check_disclosure_permitted(&env, 3u32, attr.clone(), false);
            assert!(!unpermissioned.disclosure_permitted);

            let permissioned = check_disclosure_permitted(&env, 3u32, attr, true);
            assert!(permissioned.disclosure_permitted);
        });
    }

    #[test]
    fn test_check_disclosure_confidential_never_permitted() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let admin = Address::generate(&env);
            let attr = Bytes::from_slice(&env, b"salary");
            set_attribute_privacy(&env, admin, 4u32, attr.clone(), PrivacyLevel::Confidential);

            // Even a permissioned verifier cannot auto-receive confidential attributes.
            let result = check_disclosure_permitted(&env, 4u32, attr, true);
            assert!(!result.disclosure_permitted);
        });
    }

    #[test]
    fn test_batch_check_disclosure_mixed_levels() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(&env);
        let cred_type = 5u32;

        let public_attr = Bytes::from_slice(&env, b"degree");
        let internal_attr = Bytes::from_slice(&env, b"gpa");
        let confidential_attr = Bytes::from_slice(&env, b"salary");

        env.as_contract(&contract_id, || {
            set_attribute_privacy(
                &env, admin.clone(), cred_type, public_attr.clone(), PrivacyLevel::Public,
            );
        });
        env.as_contract(&contract_id, || {
            set_attribute_privacy(
                &env, admin.clone(), cred_type, internal_attr.clone(), PrivacyLevel::Internal,
            );
        });
        env.as_contract(&contract_id, || {
            set_attribute_privacy(
                &env, admin, cred_type, confidential_attr.clone(), PrivacyLevel::Confidential,
            );
        });

        env.as_contract(&contract_id, || {
            let mut attrs: Vec<Bytes> = Vec::new(&env);
            attrs.push_back(public_attr.clone());
            attrs.push_back(internal_attr.clone());
            attrs.push_back(confidential_attr.clone());

            // Permissioned verifier.
            let result_perm = batch_check_disclosure(&env, cred_type, attrs.clone(), true);
            assert_eq!(result_perm.get(public_attr.clone()).unwrap(), true);
            assert_eq!(result_perm.get(internal_attr.clone()).unwrap(), true);
            assert_eq!(result_perm.get(confidential_attr.clone()).unwrap(), false);

            // Unpermissioned verifier.
            let result_unp = batch_check_disclosure(&env, cred_type, attrs, false);
            assert_eq!(result_unp.get(public_attr).unwrap(), true);
            assert_eq!(result_unp.get(internal_attr).unwrap(), false);
            assert_eq!(result_unp.get(confidential_attr).unwrap(), false);
        });
    }

    #[test]
    fn test_set_attribute_privacy_can_be_updated() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(&env);
        let attr = Bytes::from_slice(&env, b"license_number");

        env.as_contract(&contract_id, || {
            set_attribute_privacy(&env, admin.clone(), 1u32, attr.clone(), PrivacyLevel::Public);
        });
        env.as_contract(&contract_id, || {
            let p1 = get_attribute_privacy(&env, 1u32, attr.clone());
            assert_eq!(p1.sensitivity, PrivacyLevel::Public);
        });

        // Upgrade sensitivity.
        env.as_contract(&contract_id, || {
            set_attribute_privacy(&env, admin, 1u32, attr.clone(), PrivacyLevel::Internal);
        });
        env.as_contract(&contract_id, || {
            let p2 = get_attribute_privacy(&env, 1u32, attr);
            assert_eq!(p2.sensitivity, PrivacyLevel::Internal);
        });
    }

    #[test]
    fn test_disclosure_check_result_includes_correct_metadata() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        env.as_contract(&contract_id, || {
            let admin = Address::generate(&env);
            let attr = Bytes::from_slice(&env, b"nationality");
            set_attribute_privacy(&env, admin, 10u32, attr.clone(), PrivacyLevel::Internal);

            let result = check_disclosure_permitted(&env, 10u32, attr.clone(), false);
            assert_eq!(result.credential_type, 10u32);
            assert_eq!(result.attribute_name, attr);
            assert_eq!(result.sensitivity, PrivacyLevel::Internal);
            assert!(!result.disclosure_permitted);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public Entrypoint Tests (Issue #1360)
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_public_entrypoint_set_attribute_privacy() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let attr = Bytes::from_slice(&env, b"credit_score");
            QuorumProofContract::bbs_set_attribute_privacy(
                env.clone(),
                admin.clone(),
                5u32,
                attr.clone(),
                PrivacyLevel::Confidential,
            );

            // Verify it was stored correctly
            let policy = get_attribute_privacy(&env, 5u32, attr);
            assert_eq!(policy.sensitivity, PrivacyLevel::Confidential);
        });
    }

    #[test]
    fn test_public_entrypoint_check_disclosure_permitted() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let attr = Bytes::from_slice(&env, b"salary");
            set_attribute_privacy(&env, admin, 3u32, attr.clone(), PrivacyLevel::Internal);

            // Check through public entrypoint
            let result = QuorumProofContract::bbs_check_disclosure_permitted(
                env.clone(),
                3u32,
                attr,
                false,
            );
            assert!(!result.disclosure_permitted);
            assert_eq!(result.sensitivity, PrivacyLevel::Internal);
        });
    }

    #[test]
    fn test_public_entrypoint_batch_check_disclosure() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(&env);

        let attr1 = Bytes::from_slice(&env, b"name");
        let attr2 = Bytes::from_slice(&env, b"ssn");
        let attr3 = Bytes::from_slice(&env, b"email");

        // Each call requires the admin's auth; give each its own frame so
        // mock_all_auths doesn't see a repeat authorization for the same
        // address within a single frame (soroban-env-host rejects that as
        // Error(Auth, ExistingValue) — "frame is already authorized").
        env.as_contract(&contract_id, || {
            set_attribute_privacy(&env, admin.clone(), 2u32, attr1.clone(), PrivacyLevel::Public);
        });
        env.as_contract(&contract_id, || {
            set_attribute_privacy(&env, admin.clone(), 2u32, attr2.clone(), PrivacyLevel::Confidential);
        });
        env.as_contract(&contract_id, || {
            set_attribute_privacy(&env, admin, 2u32, attr3.clone(), PrivacyLevel::Internal);
        });

        let mut attrs = Vec::new(&env);
        attrs.push_back(attr1);
        attrs.push_back(attr2);
        attrs.push_back(attr3);

        env.as_contract(&contract_id, || {
            let results = QuorumProofContract::bbs_batch_check_disclosure(
                env.clone(),
                2u32,
                attrs.clone(),
                true, // verifier_is_permissioned
            );

            assert_eq!(results.len(), 3);
            assert_eq!(results.get(attrs.get(0).unwrap()).unwrap(), true); // public
            assert_eq!(results.get(attrs.get(1).unwrap()).unwrap(), false); // confidential
            assert_eq!(results.get(attrs.get(2).unwrap()).unwrap(), true); // internal + permissioned
        });
    }

    #[test]
    fn test_public_entrypoint_non_revocation_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(&env);
        let holder = Address::generate(&env);

        env.clone().as_contract(&contract_id, || {
            let acc_bytes = Bytes::from_slice(&env, b"accumulator-v1");
            let proof_bytes = Bytes::from_slice(&env, b"non-revocation-proof");

            // Initialize accumulator
            QuorumProofContract::bbs_add_revocation_accumulator(
                env.clone(),
                admin,
                42u64,
                acc_bytes,
            );

            // Create proof
            QuorumProofContract::bbs_create_non_revocation_proof(
                env.clone(),
                holder,
                42u64,
                proof_bytes,
            );

            // Verify through public entrypoint
            let is_valid = QuorumProofContract::bbs_verify_non_revocation(env, 42u64);
            assert!(is_valid);
        });
    }

    #[test]
    fn test_public_entrypoint_non_revocation_stale_epoch() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(&env);
        let holder = Address::generate(&env);

        let v1 = Bytes::from_slice(&env, b"acc-v1");
        let v2 = Bytes::from_slice(&env, b"acc-v2");
        let proof = Bytes::from_slice(&env, b"proof-bytes");

        // Each call requiring admin/holder auth gets its own frame — reusing
        // the same address's auth twice within one frame trips
        // mock_all_auths's Error(Auth, ExistingValue) ("frame is already
        // authorized").

        // Initialize with v1
        env.as_contract(&contract_id, || {
            QuorumProofContract::bbs_add_revocation_accumulator(
                env.clone(),
                admin.clone(),
                10u64,
                v1,
            );
        });

        // Create proof at epoch 1
        env.as_contract(&contract_id, || {
            QuorumProofContract::bbs_create_non_revocation_proof(
                env.clone(),
                holder.clone(),
                10u64,
                proof.clone(),
            );
        });

        // Proof should be valid
        env.as_contract(&contract_id, || {
            assert!(QuorumProofContract::bbs_verify_non_revocation(
                env.clone(),
                10u64
            ));
        });

        // Advance epoch
        env.as_contract(&contract_id, || {
            QuorumProofContract::bbs_add_revocation_accumulator(
                env.clone(),
                admin,
                10u64,
                v2,
            );
        });

        // Proof is now stale (epoch mismatch)
        env.as_contract(&contract_id, || {
            assert!(!QuorumProofContract::bbs_verify_non_revocation(env.clone(), 10u64));
        });
    }

    #[test]
    fn test_public_entrypoint_rotate_issuer_key() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);

        let key1 = Bytes::from_slice(&env, b"issuer-key-v1");
        let key2 = Bytes::from_slice(&env, b"issuer-key-v2");

        // Each rotation requires the admin's auth; give each its own frame
        // so mock_all_auths doesn't see a repeat authorization for the same
        // address within a single frame (soroban-env-host rejects that as
        // Error(Auth, ExistingValue) — "frame is already authorized").

        // Rotate initial key
        env.as_contract(&contract_id, || {
            QuorumProofContract::bbs_rotate_issuer_key(
                env.clone(),
                admin.clone(),
                issuer.clone(),
                key1,
            );
        });

        // Rotate to new key
        env.as_contract(&contract_id, || {
            QuorumProofContract::bbs_rotate_issuer_key(
                env.clone(),
                admin,
                issuer.clone(),
                key2,
            );
        });

        // Verify history
        env.as_contract(&contract_id, || {
            let history = get_bbs_issuer_key_history(&env, issuer.clone());
            assert_eq!(history.len(), 2);
            assert_eq!(history.get(0).unwrap().version, 1u32);
            assert_eq!(history.get(1).unwrap().version, 2u32);

            let info = get_bbs_issuer_key_info(&env, issuer);
            assert_eq!(info.current_version, 2u32);
            assert_eq!(info.total_versions, 2u32);
        });
    }

    #[test]
    fn test_public_entrypoint_privacy_enforcement_through_bbs_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let admin = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let attr = Bytes::from_slice(&env, b"medical_record");

            // Set attribute as confidential
            QuorumProofContract::bbs_set_attribute_privacy(
                env.clone(),
                admin.clone(),
                7u32,
                attr.clone(),
                PrivacyLevel::Confidential,
            );

            // Non-permissioned verifier cannot access
            let result_noperm = QuorumProofContract::bbs_check_disclosure_permitted(
                env.clone(),
                7u32,
                attr.clone(),
                false,
            );
            assert!(!result_noperm.disclosure_permitted);

            // Permissioned verifier also cannot access confidential
            let result_perm = QuorumProofContract::bbs_check_disclosure_permitted(
                env.clone(),
                7u32,
                attr,
                true,
            );
            assert!(!result_perm.disclosure_permitted);
        });
    }
}
