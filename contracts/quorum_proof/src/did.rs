//! W3C Decentralized Identifier (DID) registry (issue #1386).
//!
//! Extracted from `lib.rs`'s `impl QuorumProofContract` so the DID registry
//! (registration, resolution, key rotation, deactivation) lives in its own
//! module, matching the pattern already used by `rbac`, `circuit_breaker`,
//! and `key_escrow`. The public `QuorumProofContract` methods in `lib.rs`
//! remain the contract's ABI surface and simply delegate here.

use soroban_sdk::{Address, Bytes, Env, String, Vec};

use crate::{
    DataKey7, DidDeactivatedEventData, DidDocument, DidKeyType, DidRegisteredEventData,
    DidUpdatedEventData, EXTENDED_TTL, STANDARD_TTL, TOPIC_DID_DEACTIVATED, TOPIC_DID_REGISTERED,
    TOPIC_DID_UPDATED,
};

/// Register a new W3C DID document and link it to a Stellar address.
///
/// See `QuorumProofContract::register_did` for the full parameter and
/// panic documentation.
pub fn register_did(
    env: &Env,
    address: Address,
    did: String,
    key_type: DidKeyType,
    public_key: Bytes,
) {
    address.require_auth();

    assert!(!did.is_empty(), "DID string cannot be empty");

    // Ensure no DID already exists for this address
    assert!(
        !env.storage()
            .instance()
            .has(&DataKey7::DidByAddress(address.clone())),
        "DID already registered for this address"
    );

    // Ensure the DID is not already registered
    let did_bytes = {
        let mut buf = [0u8; 256];
        let len = did.clone().len() as usize;
        did.clone().copy_into_slice(&mut buf[..len]);
        Bytes::from_slice(env, &buf[..len])
    };
    assert!(
        !env.storage()
            .instance()
            .has(&DataKey7::DidDocument(did_bytes.clone())),
        "DID string already registered"
    );

    let count: u64 = env
        .storage()
        .instance()
        .get(&DataKey7::DidCount)
        .unwrap_or(0u64);

    let now = env.ledger().timestamp();
    let doc = DidDocument {
        did: did.clone(),
        address: address.clone(),
        method: String::from_str(env, "stellar"),
        key_type,
        public_key,
        active: true,
        created_at: now,
        updated_at: now,
    };

    env.storage()
        .instance()
        .set(&DataKey7::DidDocument(did_bytes.clone()), &doc);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    env.storage()
        .instance()
        .set(&DataKey7::DidByAddress(address.clone()), &did_bytes);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    env.storage().instance().set(&DataKey7::DidCount, &(count + 1));
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let event_data = DidRegisteredEventData {
        did: did.clone(),
        address,
        method: String::from_str(env, "stellar"),
    };
    let topic = String::from_str(env, TOPIC_DID_REGISTERED);
    let mut topics: Vec<String> = Vec::new(env);
    topics.push_back(topic);
    env.events().publish(topics, event_data);
}

/// Resolve a W3C DID document by its DID string.
/// Returns `None` if the DID is not registered.
pub fn resolve_did(env: &Env, did: String) -> Option<DidDocument> {
    let did_bytes = {
        let mut buf = [0u8; 256];
        let len = did.len() as usize;
        did.copy_into_slice(&mut buf[..len]);
        Bytes::from_slice(env, &buf[..len])
    };
    env.storage().instance().get(&DataKey7::DidDocument(did_bytes))
}

/// Look up the DID string registered for a Stellar address.
/// Returns `None` if no DID is registered for the address.
pub fn get_did_for_address(env: &Env, address: Address) -> Option<String> {
    let did_bytes: Option<Bytes> = env.storage().instance().get(&DataKey7::DidByAddress(address));
    did_bytes.map(|b| {
        let mut buf = [0u8; 256];
        let len = b.len() as usize;
        b.copy_into_slice(&mut buf[..len]);
        String::from_bytes(env, &buf[..len])
    })
}

/// Update the public key and key type for an existing DID.
/// The caller must be the address that owns the DID.
pub fn update_did(env: &Env, address: Address, new_key_type: DidKeyType, new_public_key: Bytes) {
    address.require_auth();

    let did_bytes: Bytes = env
        .storage()
        .instance()
        .get(&DataKey7::DidByAddress(address.clone()))
        .expect("no DID registered for this address");

    let mut doc: DidDocument = env
        .storage()
        .instance()
        .get(&DataKey7::DidDocument(did_bytes.clone()))
        .expect("DID document not found");

    doc.key_type = new_key_type;
    doc.public_key = new_public_key;
    doc.updated_at = env.ledger().timestamp();

    env.storage().instance().set(&DataKey7::DidDocument(did_bytes), &doc);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let event_data = DidUpdatedEventData {
        did: doc.did.clone(),
        address,
    };
    let topic = String::from_str(env, TOPIC_DID_UPDATED);
    let mut topics: Vec<String> = Vec::new(env);
    topics.push_back(topic);
    env.events().publish(topics, event_data);
}

/// Deactivate a DID document. The DID entry is marked inactive but
/// remains on-chain for resolution and audit purposes.
pub fn deactivate_did(env: &Env, address: Address) {
    address.require_auth();

    let did_bytes: Bytes = env
        .storage()
        .instance()
        .get(&DataKey7::DidByAddress(address.clone()))
        .expect("no DID registered for this address");

    let mut doc: DidDocument = env
        .storage()
        .instance()
        .get(&DataKey7::DidDocument(did_bytes.clone()))
        .expect("DID document not found");

    doc.active = false;
    doc.updated_at = env.ledger().timestamp();

    env.storage().instance().set(&DataKey7::DidDocument(did_bytes), &doc);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let event_data = DidDeactivatedEventData {
        did: doc.did.clone(),
        address,
    };
    let topic = String::from_str(env, TOPIC_DID_DEACTIVATED);
    let mut topics: Vec<String> = Vec::new(env);
    topics.push_back(topic);
    env.events().publish(topics, event_data);
}

/// Return the total number of registered DIDs.
pub fn get_did_count(env: &Env) -> u64 {
    env.storage().instance().get(&DataKey7::DidCount).unwrap_or(0u64)
}
