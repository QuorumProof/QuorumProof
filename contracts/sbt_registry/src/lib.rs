#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, Env};

// Import the QuorumProof client for cross-contract credential validation.
use quorum_proof::QuorumProofContractClient;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Token(u64),
    TokenCount,
    Owner(u64),
}

#[contracttype]
#[derive(Clone)]
pub struct SoulboundToken {
    pub id: u64,
    pub owner: Address,
    pub credential_id: u64,
    pub metadata_uri: Bytes,
}

#[contract]
pub struct SbtRegistryContract;

#[contractimpl]
impl SbtRegistryContract {
    /// Mint a soulbound token. Non-transferable by design.
    /// Validates that the credential exists in QuorumProofContract and is not revoked.
    pub fn mint(
        env: Env,
        owner: Address,
        credential_id: u64,
        metadata_uri: Bytes,
        quorum_proof_contract: Address,
    ) -> u64 {
        owner.require_auth();

        // Cross-contract call: fetch credential and validate it exists and is not revoked.
        let quorum_client = QuorumProofContractClient::new(&env, &quorum_proof_contract);
        let credential = quorum_client.get_credential(&credential_id);
        assert!(!credential.revoked, "credential is revoked");

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TokenCount)
            .unwrap_or(0u64)
            + 1;
        let token = SoulboundToken {
            id,
            owner: owner.clone(),
            credential_id,
            metadata_uri,
        };
        env.storage()
            .instance()
            .set(&DataKey::Token(id), &token);
        env.storage()
            .instance()
            .set(&DataKey::Owner(id), &owner);
        env.storage()
            .instance()
            .set(&DataKey::TokenCount, &id);
        id
    }

    /// Get a soulbound token by ID.
    pub fn get_token(env: Env, token_id: u64) -> SoulboundToken {
        env.storage()
            .instance()
            .get(&DataKey::Token(token_id))
            .expect("token not found")
    }

    /// Verify ownership of a token.
    pub fn owner_of(env: Env, token_id: u64) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Owner(token_id))
            .expect("token not found")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quorum_proof::{QuorumProofContract, QuorumProofContractClient};
    use soroban_sdk::{testutils::Address as _, Bytes, Env};

    fn setup(env: &Env) -> (SbtRegistryContractClient, QuorumProofContractClient) {
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let qp_id = env.register_contract(None, QuorumProofContract);
        (
            SbtRegistryContractClient::new(env, &sbt_id),
            QuorumProofContractClient::new(env, &qp_id),
        )
    }

    #[test]
    fn test_mint_and_ownership() {
        let env = Env::default();
        env.mock_all_auths();
        let (sbt, qp) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = qp.issue_credential(&issuer, &subject, &1u32, &metadata);

        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        let token_id = sbt.mint(&subject, &cred_id, &uri, &qp.address);
        assert_eq!(token_id, 1);
        assert_eq!(sbt.owner_of(&token_id), subject);
    }

    #[test]
    #[should_panic(expected = "credential is revoked")]
    fn test_mint_rejects_revoked_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (sbt, qp) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = qp.issue_credential(&issuer, &subject, &1u32, &metadata);

        // Revoke the credential before minting.
        qp.revoke_credential(&issuer, &cred_id);

        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        // Should panic: credential is revoked.
        sbt.mint(&subject, &cred_id, &uri, &qp.address);
    }

    #[test]
    #[should_panic(expected = "credential not found")]
    fn test_mint_rejects_nonexistent_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (sbt, qp) = setup(&env);

        let owner = Address::generate(&env);
        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        // credential_id 999 was never issued — should panic.
        sbt.mint(&owner, &999u64, &uri, &qp.address);
    }
}
