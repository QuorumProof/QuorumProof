// Fuzz testing for credential issuance
// Run with: cargo fuzz run fuzz_issue_credential

#![no_main]
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{Bytes, Env, Address};

// Mock contract for fuzzing
mod contract {
    use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Bytes, Env, String, Vec};

    #[contracterror]
    #[derive(Copy, Clone, Debug, Eq, PartialEq)]
    #[repr(u32)]
    pub enum ContractError {
        CredentialNotFound = 1,
        InvalidInput = 2,
    }

    #[contracttype]
    #[derive(Clone)]
    pub struct Credential {
        pub id: u64,
        pub subject: Address,
        pub issuer: Address,
        pub credential_type: u32,
        pub metadata_hash: Bytes,
        pub revoked: bool,
        pub expires_at: Option<u64>,
    }

    #[contracttype]
    pub enum DataKey {
        Credential(u64),
        CredentialCount,
    }

    #[contract]
    pub struct QuorumProofContract;

    #[contractimpl]
    impl QuorumProofContract {
        pub fn issue_credential(
            env: Env,
            issuer: Address,
            subject: Address,
            credential_type: u32,
            metadata_hash: Bytes,
            expires_at: Option<u64>,
        ) -> Result<u64, ContractError> {
            // Validate inputs
            if metadata_hash.is_empty() {
                return Err(ContractError::InvalidInput);
            }

            // Get next credential ID
            let count: u64 = env
                .storage()
                .persistent()
                .get(&DataKey::CredentialCount)
                .unwrap_or(Ok(0))
                .unwrap_or(0);

            let id = count + 1;

            // Create credential
            let credential = Credential {
                id,
                subject,
                issuer,
                credential_type,
                metadata_hash,
                revoked: false,
                expires_at,
            };

            // Store credential
            env.storage()
                .persistent()
                .set(&DataKey::Credential(id), &credential);
            env.storage()
                .persistent()
                .set(&DataKey::CredentialCount, &id);

            Ok(id)
        }

        pub fn get_credential(env: Env, credential_id: u64) -> Result<Credential, ContractError> {
            env.storage()
                .persistent()
                .get(&DataKey::Credential(credential_id))
                .ok_or(ContractError::CredentialNotFound)?
        }
    }
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 32 {
        return; // Need minimum data for fuzzing
    }

    let env = Env::default();
    env.mock_all_auths();

    // Parse fuzz input
    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    let credential_type = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    let expires_at = if data[4] > 128 {
        Some(u64::from_le_bytes([
            data[5], data[6], data[7], data[8], data[9], data[10], data[11], data[12],
        ]))
    } else {
        None
    };

    // Metadata hash from remaining data
    let metadata_hash = Bytes::from_slice(&env, &data[13..]);

    // Skip if metadata is empty (invalid)
    if metadata_hash.is_empty() {
        return;
    }

    // Try to issue credential
    let contract_id = env.register_contract(None, contract::QuorumProofContract);
    let client = contract::QuorumProofContractClient::new(&env, &contract_id);

    if let Ok(id) = client.issue_credential(&issuer, &subject, &credential_type, &metadata_hash, &expires_at) {
        // Verify credential was stored correctly
        if let Ok(cred) = client.get_credential(&id) {
            assert_eq!(cred.id, id);
            assert_eq!(cred.subject, subject);
            assert_eq!(cred.issuer, issuer);
            assert_eq!(cred.credential_type, credential_type);
            assert_eq!(cred.metadata_hash, metadata_hash);
            assert!(!cred.revoked);
            assert_eq!(cred.expires_at, expires_at);
        }
    }
});
