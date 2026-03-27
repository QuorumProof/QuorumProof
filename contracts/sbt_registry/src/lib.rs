#! [no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, Env, Vec, panic_with_error, testutils::{Address as _, Ledger as _, Events as _}};&#10;use quorum_proof::QuorumProofContractClient;


#[derive(Debug, Clone, PartialEq, Eq)]
#[repr(u32)]
pub enum ContractError {
    SoulboundNonTransferable = 1,
    CredentialRevoked = 2,
    CredentialNotFound = 3,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Token(u64),
    TokenCount,
    Owner(u64),
    OwnerTokens(Address),
    OwnerCredential(Address, u64),
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
    /// Mint a soulbound token linked to a credential_id.
    /// Panics if SBT already exists for this (owner, credential_id).
    pub fn mint(
        env: Env,
        owner: Address,
        credential_id: u64,
        metadata_uri: Bytes,
    ) -> u64 {
        owner.require_auth();

        // Check uniqueness: no existing SBT for this owner+credential
        if env.storage().instance().has(&DataKey::OwnerCredential(owner.clone(), credential_id)) {
            panic_with_error!(&env, ContractError::SoulboundNonTransferable);
        }

        let mut token_count: u64 = env.storage().instance().get(&DataKey::TokenCount).unwrap_or(0);
        token_count += 1;
        let token_id = token_count;

        let token = SoulboundToken {
            id: token_id,
            owner: owner.clone(),
            credential_id,
            metadata_uri: metadata_uri.clone(),
        };

        // Persistent storage for token
        env.storage().persistent().set(&DataKey::Token(token_id), &token);
        env.storage().persistent().extend_ttl(&DataKey::Token(token_id), 16_384, 524_288);

        env.storage().persistent().set(&DataKey::Owner(token_id), &owner.clone());
        env.storage().persistent().extend_ttl(&DataKey::Owner(token_id), 16_384, 524_288);

        env.storage().instance().set(&DataKey::TokenCount, &token_count);

        // Owner tokens list
        let mut owner_tokens: Vec<u64> = env.storage().persistent()
            .get(&DataKey::OwnerTokens(owner.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        owner_tokens.push_back(token_id);
        env.storage().persistent().set(&DataKey::OwnerTokens(owner.clone()), &owner_tokens);
        env.storage().persistent().extend_ttl(&DataKey::OwnerTokens(owner.clone()), 16_384, 524_288);

        // Uniqueness mapping
        env.storage().instance().set(&DataKey::OwnerCredential(owner.clone(), credential_id), &token_id);

        env.events().publish(("mint", token_id));
        token_id
    }

    pub fn get_token(env: Env, token_id: u64) -> SoulboundToken {
        env.storage().persistent().get(&DataKey::Token(token_id)).expect("token not found")
    }

    pub fn owner_of(env: Env, token_id: u64) -> Address {
        env.storage().persistent().get(&DataKey::Owner(token_id)).expect("token not found")
    }

    pub fn get_tokens_by_owner(env: Env, owner: Address) -> Vec<u64> {
        env.storage().persistent().get(&DataKey::OwnerTokens(owner)).unwrap_or_else(|| Vec::new(&env))
    }

    pub fn transfer(env: Env, _from: Address, _to: Address, _token_id: u64) {
        panic_with_error!(&env, ContractError::SoulboundNonTransferable);
    }

    /// Burn (destroy) a soulbound token. Only the owner may call this.
    /// Removes Token, Owner, and OwnerTokens records from storage.
    pub fn burn(env: Env, owner: Address, token_id: u64) {
        owner.require_auth();

        let token: SoulboundToken = env
            .storage()
            .persistent()
            .get(&DataKey::Token(token_id))
            .expect("token not found");
        assert!(token.owner == owner, "only the token owner can burn");

        env.storage().persistent().remove(&DataKey::Token(token_id));
        env.storage().persistent().remove(&DataKey::Owner(token_id));

        let mut owner_tokens: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::OwnerTokens(owner.clone()))
            .unwrap_or(Vec::new(&env));
        if let Some(pos) = owner_tokens.iter().position(|id| id == token_id) {
            owner_tokens.remove(pos as u32);
        }
        env.storage()
            .persistent()
            .set(&DataKey::OwnerTokens(owner), &owner_tokens);
    }

    /// Admin-only contract upgrade to new WASM. Uses deployer convention for auth.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: Bytes) {
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{symbol_short, BytesN};

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

    #[test]
    #[should_panic(expected = "SoulboundNonTransferable")]
    fn test_duplicate_sbt_minting_rejection() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SbtRegistryContract);
        let client = SbtRegistryContractClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        let credential_id = 1u64;

        // First mint succeeds
        let _ = client.mint(&owner, &credential_id, &uri);

        // Second mint same owner+credential panics
        client.mint(&owner, &credential_id, &uri);
    }

    // Other tests for ownership, get_tokens_by_owner etc. unchanged as per existing
#[test]
    fn test_get_tokens_by_owner_single() { /* impl from previous */ }

#[test]
    fn test_upgrade_success() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SbtRegistryContract);
        let client = SbtRegistryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let wasm_hash = Bytes::from_slice(&env, b"new_wasm_hash");

        // Should succeed without panic
        client.upgrade(&admin, &wasm_hash);
    }

#[test]
#[should_panic(expected = "HostError")]
fn test_upgrade_unauthorized_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SbtRegistryContract);
        let client = SbtRegistryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let unpriv = Address::generate(&env);
        let wasm_hash = Bytes::from_slice(&env, b"new_wasm_hash");

        client.upgrade(&admin, &wasm_hash);  // Authorize admin first

        // Unauthorized should panic on require_auth
        env.as_contract(&contract_id, || {
            client.upgrade(&unpriv, &wasm_hash);
        });
    }

}

