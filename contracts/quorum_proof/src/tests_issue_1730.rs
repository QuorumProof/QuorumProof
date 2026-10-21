/// Tests for Issue #1730: `is_attested` must enforce the multi-sig attestation policy
/// instead of the former always-true stub.
#[cfg(test)]
mod tests_multisig_attestation_gate {
    use super::*;
    use soroban_sdk::vec;

    const CRED_TYPE: u32 = 7;

    struct Setup<'a> {
        env: Env,
        client: QuorumProofContractClient<'a>,
        admin: Address,
        issuer: Address,
        subject: Address,
        a1: Address,
        a2: Address,
        slice_id: u64,
    }

    fn setup<'a>() -> Setup<'a> {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let a1 = Address::generate(&env);
        let a2 = Address::generate(&env);

        let attestors = vec![&env, a1.clone(), a2.clone()];
        let weights = vec![&env, 50u32, 50u32];
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &50u32);

        Setup {
            env,
            client,
            admin,
            issuer,
            subject,
            a1,
            a2,
            slice_id,
        }
    }

    fn issue(s: &Setup, credential_type: u32) -> u64 {
        let metadata = Bytes::from_slice(&s.env, b"multisig_gate_metadata");
        s.client
            .issue_credential(&s.issuer, &s.subject, &credential_type, &metadata, &None, &0u64)
    }

    /// Move the ledger clock forward so the 60s verification cache cannot serve a stale result.
    fn advance_past_cache(env: &Env) {
        env.ledger().with_mut(|li| {
            li.timestamp += 120;
        });
    }

    #[test]
    fn test_no_policy_is_attested_without_multisig() {
        let s = setup();
        let cred_id = issue(&s, CRED_TYPE);
        s.client.attest(&s.a1, &cred_id, &s.slice_id, &true, &None);
        s.client.attest(&s.a2, &cred_id, &s.slice_id, &true, &None);

        assert!(s.client.is_attested(&cred_id, &s.slice_id));
    }

    #[test]
    fn test_is_attested_false_when_multisig_policy_unmet() {
        let s = setup();
        s.client
            .set_attestation_policy(&s.admin, &CRED_TYPE, &CredentialSensitivity::High, &2u32, &3600u64);
        let cred_id = issue(&s, CRED_TYPE);

        // Slice weight is sufficient on its own, but no multi-sig request has executed.
        s.client.attest(&s.a1, &cred_id, &s.slice_id, &true, &None);
        s.client.attest(&s.a2, &cred_id, &s.slice_id, &true, &None);

        assert!(!s.client.is_attested(&cred_id, &s.slice_id));
    }

    #[test]
    fn test_is_attested_false_while_multisig_request_is_pending() {
        let s = setup();
        s.client
            .set_attestation_policy(&s.admin, &CRED_TYPE, &CredentialSensitivity::High, &2u32, &3600u64);
        let cred_id = issue(&s, CRED_TYPE);
        s.client.attest(&s.a1, &cred_id, &s.slice_id, &true, &None);
        s.client.attest(&s.a2, &cred_id, &s.slice_id, &true, &None);

        // Initiator counts as the first signature; threshold is 2, so the request stays pending.
        let required = vec![&s.env, s.a1.clone(), s.a2.clone()];
        let request_id =
            s.client
                .request_multisig_attestation(&s.a1, &cred_id, &s.slice_id, &required, &true);

        advance_past_cache(&s.env);
        assert!(!s.client.is_attested(&cred_id, &s.slice_id));
        let request = s.client.get_attestation_request(&request_id).unwrap();
        assert!(!request.executed);
    }

    #[test]
    fn test_is_attested_true_once_multisig_threshold_met() {
        let s = setup();
        s.client
            .set_attestation_policy(&s.admin, &CRED_TYPE, &CredentialSensitivity::High, &2u32, &3600u64);
        let cred_id = issue(&s, CRED_TYPE);
        s.client.attest(&s.a1, &cred_id, &s.slice_id, &true, &None);
        s.client.attest(&s.a2, &cred_id, &s.slice_id, &true, &None);

        let required = vec![&s.env, s.a1.clone(), s.a2.clone()];
        let request_id =
            s.client
                .request_multisig_attestation(&s.a1, &cred_id, &s.slice_id, &required, &true);
        let executed = s.client.sign_attestation_request(&s.a2, &request_id);
        assert!(executed);

        advance_past_cache(&s.env);
        assert!(s.client.is_attested(&cred_id, &s.slice_id));
    }

    #[test]
    fn test_rejected_multisig_request_does_not_satisfy_gate() {
        let s = setup();
        s.client
            .set_attestation_policy(&s.admin, &CRED_TYPE, &CredentialSensitivity::High, &2u32, &3600u64);
        let cred_id = issue(&s, CRED_TYPE);
        s.client.attest(&s.a1, &cred_id, &s.slice_id, &true, &None);
        s.client.attest(&s.a2, &cred_id, &s.slice_id, &true, &None);

        // A multi-sig request recording a negative attestation must not approve the credential.
        let required = vec![&s.env, s.a1.clone(), s.a2.clone()];
        let request_id =
            s.client
                .request_multisig_attestation(&s.a1, &cred_id, &s.slice_id, &required, &false);
        assert!(s.client.sign_attestation_request(&s.a2, &request_id));

        advance_past_cache(&s.env);
        assert!(!s.client.is_attested(&cred_id, &s.slice_id));
    }
}
