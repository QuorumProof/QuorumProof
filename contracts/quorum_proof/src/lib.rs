#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Credential(u64),
    CredentialCount,
    Slice(u64),
    SliceCount,
    Attestors(u64),
}

#[contracttype]
#[derive(Clone)]
pub struct Credential {
    pub id: u64,
    pub subject: Address,
    pub issuer: Address,
    pub credential_type: u32,
    pub metadata_hash: soroban_sdk::Bytes,
    pub revoked: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct QuorumSlice {
    pub id: u64,
    pub attestors: Vec<Address>,
    pub threshold: u32,
}

#[contract]
pub struct QuorumProofContract;

#[contractimpl]
impl QuorumProofContract {
    /// Issue a new credential. Returns the credential ID.
pub fn issue_credential(
        env: Env,
        issuer: Address,
        subject: Address,
        credential_type: u32,
        metadata_hash: soroban_sdk::Bytes,
    ) -> u64 {
        issuer.require_auth();
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CredentialCount)
            .unwrap_or(0u64)
            + 1;
        let credential = Credential {
            id,
            subject,
            issuer,
            credential_type,
            metadata_hash,
            revoked: false,
        };
        env.storage()
            .instance()
            .set(&DataKey::Credential(id), &credential);
        env.storage()
            .instance()
            .set(&DataKey::CredentialCount, &id);
        id
    }

    /// Retrieve a credential by ID.
    pub fn get_credential(env: Env, credential_id: u64) -> Credential {
        env.storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .expect("credential not found")
    }

    /// Revoke a credential. Can be called by either the subject or the issuer.
    pub fn revoke_credential(env: Env, caller: Address, credential_id: u64) {
        caller.require_auth();
        let mut credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .expect("credential not found");
        assert!(
            caller == credential.subject || caller == credential.issuer,
            "only subject or issuer can revoke"
        );
        credential.revoked = true;
        env.storage()
            .instance()
            .set(&DataKey::Credential(credential_id), &credential);
    }

    /// Create a quorum slice. Returns the slice ID.
    pub fn create_slice(env: Env, attestors: Vec<Address>, threshold: u32) -> u64 {
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::SliceCount)
            .unwrap_or(0u64)
            + 1;
        let slice = QuorumSlice {
            id,
            attestors,
            threshold,
        };
        env.storage()
            .instance()
            .set(&DataKey::Slice(id), &slice);
        env.storage()
            .instance()
            .set(&DataKey::SliceCount, &id);
        id
    }

    /// Retrieve a quorum slice by ID.
    pub fn get_slice(env: Env, slice_id: u64) -> QuorumSlice {
        env.storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .expect("slice not found")
    }

    /// Attest a credential using a quorum slice.
    pub fn attest(env: Env, attestor: Address, credential_id: u64, slice_id: u64) {
        attestor.require_auth();
        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .expect("slice not found");
        // Verify attestor is in the slice
        let mut found = false;
        for a in slice.attestors.iter() {
            if a == attestor {
                found = true;
                break;
            }
        }
        assert!(found, "attestor not in slice");

        let mut attestors: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env));
        attestors.push_back(attestor);
        env.storage()
            .instance()
            .set(&DataKey::Attestors(credential_id), &attestors);
    }

    /// Check if a credential has met its quorum threshold.
    pub fn is_attested(env: Env, credential_id: u64, slice_id: u64) -> bool {
        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .expect("slice not found");
        let attestors: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env));
        attestors.len() >= slice.threshold
    }

    /// Get all attestors for a credential.
    pub fn get_attestors(env: Env, credential_id: u64) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Bytes, Env};

    #[test]
    fn test_issue_and_get_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata);
        assert_eq!(id, 1);

        let cred = client.get_credential(&id);
        assert_eq!(cred.subject, subject);
        assert_eq!(cred.issuer, issuer);
        assert!(!cred.revoked);
    }

    #[test]
    fn test_quorum_slice_and_attestation() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);

        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata);

        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(attestor1.clone());
        attestors.push_back(attestor2.clone());
        let slice_id = client.create_slice(&attestors, &2u32);

        assert!(!client.is_attested(&cred_id, &slice_id));
        client.attest(&attestor1, &cred_id, &slice_id);
        assert!(!client.is_attested(&cred_id, &slice_id));
        client.attest(&attestor2, &cred_id, &slice_id);
        assert!(client.is_attested(&cred_id, &slice_id));
    }

    #[test]
    fn test_issuer_revoke_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata);

        // Revoke as issuer
        client.revoke_credential(&issuer, &id);

        let cred = client.get_credential(&id);
        assert!(cred.revoked);
        assert_eq!(cred.issuer, issuer);
        assert_eq!(cred.subject, subject);
    }

    #[test]
    fn test_subject_revoke_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata);

        // Revoke as subject
        client.revoke_credential(&subject, &id);

        let cred = client.get_credential(&id);
        assert!(cred.revoked);
        assert_eq!(cred.issuer, issuer);
        assert_eq!(cred.subject, subject);
    }

    #[test]
    #[should_panic(expected = "only subject or issuer can revoke")]
    fn test_unauthorized_revoke_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let unauthorized = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata);

        // Attempt to revoke as unauthorized user - should panic
        client.revoke_credential(&unauthorized, &id);
    }
}
