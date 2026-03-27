#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, contracterror, panic_with_error, Address, Env, String, Vec};
use sbt_registry::SbtRegistryContractClient;
use zk_verifier::{ClaimType, ZkVerifierContractClient};

const TOPIC_ISSUE: &str = "CredentialIssued";
const TOPIC_REVOKE: &str = "RevokeCredential";
const TOPIC_ATTESTATION: &str = "attestation";
const STANDARD_TTL: u32 = 16_384;
const EXTENDED_TTL: u32 = 524_288;
const MAX_ATTESTORS_PER_SLICE: u32 = 20;

#[contracttype]
#[derive(Clone)]
pub struct IssueEventData {
    pub id: u64,
    pub subject: Address,
    pub credential_type: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct RevokeEventData {
    pub credential_id: u64,
    pub subject: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct AttestationEventData {
    pub attestor: Address,
    pub credential_id: u64,
    pub slice_id: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    CredentialNotFound = 1,
    SliceNotFound = 2,
    ContractPaused = 3,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Credential(u64),
    CredentialCount,
    Slice(u64),
    SliceCount,
    Attestors(u64),
    SubjectCredentials(Address),
    AttestorCount(Address),
    CredentialType(u32),
    Admin,
    Paused,
}

#[contracttype]
#[derive(Clone)]
pub struct CredentialTypeDef {
    pub type_id: u32,
    pub name: soroban_sdk::String,
    pub description: soroban_sdk::String,
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
    pub expires_at: Option<u64>,
}

#[contracttype]
#[derive(Clone)]
pub struct QuorumSlice {
    pub id: u64,
    pub creator: Address,
    pub attestors: Vec<Address>,
    pub threshold: u32,
}

#[contract]
pub struct QuorumProofContract;

#[contractimpl]
impl QuorumProofContract {
    /// Set the admin address once after deployment. Panics if already initialized.
    pub fn initialize(env: Env, admin: Address) {
        assert!(!env.storage().instance().has(&DataKey::Admin), "already initialized");
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Pause the contract. Only admin may call this.
    pub fn pause(env: Env, admin: Address) {
        admin.require_auth();
        let stored: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        assert!(stored == admin, "unauthorized");
        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Unpause the contract. Only admin may call this.
    pub fn unpause(env: Env, admin: Address) {
        admin.require_auth();
        let stored: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        assert!(stored == admin, "unauthorized");
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Returns true if the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    fn require_not_paused(env: &Env) {
        if env.storage().instance().get(&DataKey::Paused).unwrap_or(false) {
            panic_with_error!(env, ContractError::ContractPaused);
        }
    }

    /// Issue a new credential. Returns the credential ID.
    pub fn issue_credential(
        env: Env,
        issuer: Address,
        subject: Address,
        credential_type: u32,
        metadata_hash: soroban_sdk::Bytes,
        expires_at: Option<u64>,
    ) -> u64 {
        issuer.require_auth();
        Self::require_not_paused(&env);
        assert!(!metadata_hash.is_empty(), "metadata_hash cannot be empty");
        let id: u64 = env.storage().instance().get(&DataKey::CredentialCount).unwrap_or(0u64) + 1;
        let credential = Credential { id, subject: subject.clone(), issuer, credential_type, metadata_hash, revoked: false, expires_at };
        env.storage().instance().set(&DataKey::Credential(id), &credential);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        env.storage().instance().set(&DataKey::CredentialCount, &id);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        let mut subject_creds: Vec<u64> = env.storage().instance().get(&DataKey::SubjectCredentials(subject.clone())).unwrap_or(Vec::new(&env));
        subject_creds.push_back(id);
        env.storage().instance().set(&DataKey::SubjectCredentials(subject), &subject_creds);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        let event_data = IssueEventData { id, subject: credential.subject.clone(), credential_type };
        let topic = String::from_str(&env, TOPIC_ISSUE);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);
        id
    }

    /// Issue credentials to multiple subjects in one call.
    pub fn batch_issue_credentials(
        env: Env,
        issuer: Address,
        subjects: Vec<Address>,
        credential_types: Vec<u32>,
        metadata_hashes: Vec<soroban_sdk::Bytes>,
        expires_at: Option<u64>,
    ) -> Vec<u64> {
        issuer.require_auth();
        Self::require_not_paused(&env);
        let n = subjects.len();
        assert!(credential_types.len() == n && metadata_hashes.len() == n, "input lengths must match");
        let mut ids: Vec<u64> = Vec::new(&env);
        for i in 0..n {
            let id = Self::issue_inner(&env, issuer.clone(), subjects.get(i).unwrap(), credential_types.get(i).unwrap(), metadata_hashes.get(i).unwrap(), expires_at.clone());
            ids.push_back(id);
        }
        ids
    }

    fn issue_inner(env: &Env, issuer: Address, subject: Address, credential_type: u32, metadata_hash: soroban_sdk::Bytes, expires_at: Option<u64>) -> u64 {
        assert!(!metadata_hash.is_empty(), "metadata_hash cannot be empty");
        let id: u64 = env.storage().instance().get(&DataKey::CredentialCount).unwrap_or(0u64) + 1;
        let credential = Credential { id, subject: subject.clone(), issuer, credential_type, metadata_hash, revoked: false, expires_at };
        env.storage().instance().set(&DataKey::Credential(id), &credential);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        env.storage().instance().set(&DataKey::CredentialCount, &id);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        let mut subject_creds: Vec<u64> = env.storage().instance().get(&DataKey::SubjectCredentials(subject.clone())).unwrap_or(Vec::new(env));
        subject_creds.push_back(id);
        env.storage().instance().set(&DataKey::SubjectCredentials(subject), &subject_creds);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        let event_data = IssueEventData { id, subject: credential.subject.clone(), credential_type };
        let topic = String::from_str(env, TOPIC_ISSUE);
        let mut topics: Vec<String> = Vec::new(env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);
        id
    }

    /// Retrieve a credential by ID.
    pub fn get_credential(env: Env, credential_id: u64) -> Credential {
        let credential: Credential = env.storage().instance().get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        if let Some(expires_at) = credential.expires_at {
            assert!(env.ledger().timestamp() < expires_at, "credential has expired");
        }
        credential
    }

    /// Return all credential IDs issued to a subject.
    pub fn get_credentials_by_subject(env: Env, subject: Address) -> Vec<u64> {
        env.storage().instance().get(&DataKey::SubjectCredentials(subject)).unwrap_or(Vec::new(&env))
    }

    /// Revoke a credential. Can be called by either the subject or the issuer.
    pub fn revoke_credential(env: Env, caller: Address, credential_id: u64) {
        caller.require_auth();
        Self::require_not_paused(&env);
        let mut credential: Credential = env.storage().instance().get(&DataKey::Credential(credential_id)).expect("credential not found");
        assert!(caller == credential.subject || caller == credential.issuer, "only subject or issuer can revoke");
        assert!(!credential.revoked, "credential already revoked");
        credential.revoked = true;
        env.storage().instance().set(&DataKey::Credential(credential_id), &credential);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        let event_data = RevokeEventData { credential_id, subject: credential.subject.clone() };
        let topic = String::from_str(&env, TOPIC_REVOKE);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);
    }

    /// Create a quorum slice. Returns the slice ID.
    pub fn create_slice(env: Env, creator: Address, attestors: Vec<Address>, threshold: u32) -> u64 {
        creator.require_auth();
        assert!(!attestors.is_empty(), "attestors cannot be empty");
        assert!(attestors.len() as u32 <= MAX_ATTESTORS_PER_SLICE, "attestors exceed maximum allowed per slice");
        assert!(threshold > 0, "threshold must be greater than 0");
        assert!(threshold <= attestors.len() as u32, "threshold cannot exceed attestors count");
        let id: u64 = env.storage().instance().get(&DataKey::SliceCount).unwrap_or(0u64) + 1;
        let slice = QuorumSlice { id, creator, attestors, threshold };
        env.storage().instance().set(&DataKey::Slice(id), &slice);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        env.storage().instance().set(&DataKey::SliceCount, &id);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        id
    }

    /// Retrieve a quorum slice by ID.
    pub fn get_slice(env: Env, slice_id: u64) -> QuorumSlice {
        env.storage().instance().get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound))
    }

    /// Return the creator address of a slice.
    pub fn get_slice_creator(env: Env, slice_id: u64) -> Address {
        let slice: QuorumSlice = env.storage().instance().get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));
        slice.creator
    }

    /// Add a new attestor to an existing quorum slice.
    pub fn add_attestor(env: Env, creator: Address, slice_id: u64, attestor: Address) {
        creator.require_auth();
        let mut slice: QuorumSlice = env.storage().instance().get(&DataKey::Slice(slice_id)).expect("slice not found");
        assert!(slice.creator == creator, "only the slice creator can add attestors");
        assert!((slice.attestors.len() as u32) < MAX_ATTESTORS_PER_SLICE, "attestors exceed maximum allowed per slice");
        for a in slice.attestors.iter() {
            assert!(a != attestor, "attestor already in slice");
        }
        slice.attestors.push_back(attestor);
        env.storage().instance().set(&DataKey::Slice(slice_id), &slice);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Update the threshold of an existing quorum slice.
    pub fn update_threshold(env: Env, creator: Address, slice_id: u64, new_threshold: u32) {
        creator.require_auth();
        let mut slice: QuorumSlice = env.storage().instance().get(&DataKey::Slice(slice_id)).expect("slice not found");
        assert!(slice.creator == creator, "only the slice creator can update threshold");
        assert!(new_threshold <= slice.attestors.len(), "threshold exceeds attestor count");
        slice.threshold = new_threshold;
        env.storage().instance().set(&DataKey::Slice(slice_id), &slice);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Attest a credential using a quorum slice.
    pub fn attest(env: Env, attestor: Address, credential_id: u64, slice_id: u64) {
        attestor.require_auth();
        Self::require_not_paused(&env);
        let credential: Credential = env.storage().instance().get(&DataKey::Credential(credential_id)).expect("credential not found");
        assert!(!credential.revoked, "credential is revoked");
        let slice: QuorumSlice = env.storage().instance().get(&DataKey::Slice(slice_id)).expect("slice not found");
        let mut found = false;
        for a in slice.attestors.iter() {
            if a == attestor { found = true; break; }
        }
        assert!(found, "attestor not in slice");
        let mut attestors: Vec<Address> = env.storage().instance().get(&DataKey::Attestors(credential_id)).unwrap_or(Vec::new(&env));
        for existing in attestors.iter() {
            if existing == attestor { panic!("attestor has already attested for this credential"); }
        }
        attestors.push_back(attestor.clone());
        env.storage().instance().set(&DataKey::Attestors(credential_id), &attestors);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        let event_data = AttestationEventData { attestor: attestor.clone(), credential_id, slice_id };
        let topic = String::from_str(&env, TOPIC_ATTESTATION);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);
        let count: u64 = env.storage().instance().get(&DataKey::AttestorCount(attestor.clone())).unwrap_or(0u64);
        env.storage().instance().set(&DataKey::AttestorCount(attestor), &(count + 1));
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Check if a credential has met its quorum threshold.
    pub fn is_attested(env: Env, credential_id: u64, slice_id: u64) -> bool {
        let credential: Credential = env.storage().instance().get(&DataKey::Credential(credential_id)).expect("credential not found");
        if credential.revoked { return false; }
        if let Some(expires_at) = credential.expires_at {
            if env.ledger().timestamp() >= expires_at { return false; }
        }
        let slice: QuorumSlice = env.storage().instance().get(&DataKey::Slice(slice_id)).expect("slice not found");
        let attestors: Vec<Address> = env.storage().instance().get(&DataKey::Attestors(credential_id)).unwrap_or(Vec::new(&env));
        attestors.len() >= slice.threshold
    }

    /// Returns true if the credential has been revoked.
    pub fn is_revoked(env: Env, credential_id: u64) -> bool {
        let credential: Credential = env.storage().instance().get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        credential.revoked
    }

    /// Returns true if the credential exists and its expiry timestamp has passed.
    pub fn is_expired(env: Env, credential_id: u64) -> bool {
        let credential: Credential = env.storage().instance().get(&DataKey::Credential(credential_id)).expect("credential not found");
        match credential.expires_at {
            Some(expires_at) => env.ledger().timestamp() >= expires_at,
            None => false,
        }
    }

    /// Get all attestors for a credential.
    pub fn get_attestors(env: Env, credential_id: u64) -> Vec<Address> {
        env.storage().instance().get(&DataKey::Attestors(credential_id)).unwrap_or(Vec::new(&env))
    }

    /// Returns the total number of credentials an attestor has signed.
    pub fn get_attestor_reputation(env: Env, attestor: Address) -> u64 {
        env.storage().instance().get(&DataKey::AttestorCount(attestor)).unwrap_or(0u64)
    }

    /// Returns the total number of credentials issued.
    pub fn get_credential_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::CredentialCount).unwrap_or(0u64)
    }

    /// Returns the total number of slices created.
    pub fn get_slice_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::SliceCount).unwrap_or(0u64)
    }

    /// Unified engineer verification entry point.
    pub fn verify_engineer(
        env: Env,
        quorum_proof_id: Address,
        sbt_registry_id: Address,
        zk_verifier_id: Address,
        subject: Address,
        credential_id: u64,
        claim_type: ClaimType,
        proof: soroban_sdk::Bytes,
    ) -> bool {
        let sbt_client = SbtRegistryContractClient::new(&env, &sbt_registry_id);
        let tokens = sbt_client.get_tokens_by_owner(&subject);
        let has_sbt = tokens.iter().any(|token_id| {
            let token = sbt_client.get_token(&token_id);
            token.credential_id == credential_id
        });
        if !has_sbt { return false; }
        let zk_client = ZkVerifierContractClient::new(&env, &zk_verifier_id);
        zk_client.verify_claim(&quorum_proof_id, &credential_id, &claim_type, &proof)
    }

    /// Register a human-readable label for a credential type.
    pub fn register_credential_type(env: Env, admin: Address, type_id: u32, name: soroban_sdk::String, description: soroban_sdk::String) {
        admin.require_auth();
        let def = CredentialTypeDef { type_id, name, description };
        env.storage().instance().set(&DataKey::CredentialType(type_id), &def);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Look up the registered name and description for a credential type.
    pub fn get_credential_type(env: Env, type_id: u32) -> CredentialTypeDef {
        env.storage().instance().get(&DataKey::CredentialType(type_id)).expect("credential type not registered")
    }

    /// Admin-only contract upgrade to new WASM.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) {
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Bytes, testutils::Address as _};

    fn setup(env: &Env) -> (QuorumProofContractClient, Address) {
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        (client, admin)
    }

    #[test]
    fn test_is_paused_false_before_pause() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        assert!(!client.is_paused());
    }

    #[test]
    fn test_pause_and_unpause() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        client.pause(&admin);
        assert!(client.is_paused());

        client.unpause(&admin);
        assert!(!client.is_paused());
    }

    #[test]
    fn test_unpause_allows_issue_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        client.pause(&admin);
        client.unpause(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None);
        assert_eq!(id, 1);
    }

    #[test]
    #[should_panic]
    fn test_pause_blocks_issue_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        client.pause(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        client.issue_credential(&issuer, &subject, &1u32, &metadata, &None);
    }

    #[test]
    #[should_panic]
    fn test_pause_blocks_revoke_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None);

        client.pause(&admin);
        client.revoke_credential(&issuer, &id);
    }

    #[test]
    #[should_panic]
    fn test_pause_blocks_attest() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None);

        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(attestor.clone());
        let slice_id = client.create_slice(&issuer, &attestors, &1u32);

        client.pause(&admin);
        client.attest(&attestor, &cred_id, &slice_id);
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn test_pause_unauthorized_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let non_admin = Address::generate(&env);
        client.pause(&non_admin);
    }

    #[test]
    fn test_is_revoked() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None);

        assert!(!client.is_revoked(&id));
        client.revoke_credential(&issuer, &id);
        assert!(client.is_revoked(&id));
    }
}
