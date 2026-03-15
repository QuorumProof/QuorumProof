#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, Env};

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
    pub fn mint(env: Env, owner: Address, credential_id: u64, metadata_uri: Bytes) -> u64 {
        owner.require_auth();
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
    use soroban_sdk::{testutils::Address as _, Bytes, Env};

    #[test]
    fn test_mint_and_ownership() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SbtRegistryContract);
        let client = SbtRegistryContractClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        let token_id = client.mint(&owner, &1u64, &uri);
        assert_eq!(token_id, 1);
        assert_eq!(client.owner_of(&token_id), owner);
    }
}
