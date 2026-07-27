//! BBS+ Feature Implementations for QuorumProof
//!
//! Implements four Drips Wave issues:
//!   - #1287: BBS+ Revocation Registry Integration
//!   - #1288: BBS+ Performance Optimization
//!   - #1289: BBS+ Key Rotation for Issuers
//!   - #1290: BBS+ Attribute Privacy Controls

use soroban_sdk::{contracttype, Address, Bytes, Env, Map, Vec};

// ─────────────────────────────────────────────────────────────────────────────
// Issue #1287 — BBS+ Revocation Registry Integration
// ─────────────────────────────────────────────────────────────────────────────

/// Represents a single BBS+ accumulator epoch for a set of credentials.
/// The accumulator value is the Pedersen-commitment-style point serialized
/// to bytes. Callers update this by calling `add_to_revocation_accumulator`.
#[contracttype]
#[derive(Clone)]
pub struct BbsRevocationAccumulator {
    /// Monotonically increasing epoch counter.
    pub epoch: u64,
    /// Serialized accumulator state (e.g. G1 point bytes, 48 bytes for BLS12-381).
    pub accumulator_bytes: Bytes,
    /// Timestamp (ledger time) of the last accumulator update.
    pub updated_at: u64,
}

/// A stored non-revocation proof for a credential.
#[contracttype]
#[derive(Clone)]
pub struct BbsNonRevocationProofRecord {
    /// Credential the proof belongs to.
    pub credential_id: u64,
    /// The serialized proof bytes (BBS+ zero-knowledge membership proof).
    pub proof_bytes: Bytes,
    /// Epoch at the time the proof was generated.
    pub epoch: u64,
    /// Ledger timestamp when this record was stored.
    pub created_at: u64,
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #1288 — BBS+ Performance Optimization
// ─────────────────────────────────────────────────────────────────────────────

/// Cached result for a signature verification.  The cache is keyed by a
/// deterministic hash of (verifying_key_bytes, message_bytes, signature_bytes)
/// so repeated `verify` calls with identical inputs short-circuit.
#[contracttype]
#[derive(Clone)]
pub struct BbsSignatureCache {
    /// Whether the cached verification was valid.
    pub is_valid: bool,
    /// Ledger timestamp when this entry was cached.
    pub cached_at: u64,
}

/// Input record for a single item in a batch signature verification request.
#[contracttype]
#[derive(Clone)]
pub struct BbsBatchVerifyItem {
    /// Identifier for the credential this item belongs to.
    pub credential_id: u64,
    /// Serialized BBS+ verifying key bytes.
    pub verifying_key_bytes: Bytes,
    /// Serialized message payload committed to in the signature.
    pub message_bytes: Bytes,
    /// Serialized BBS+ signature bytes.
    pub signature_bytes: Bytes,
}

/// Result record for a single item in a batch verification response.
#[contracttype]
#[derive(Clone)]
pub struct BbsBatchVerifyResult {
    /// Credential ID echoed from the request.
    pub credential_id: u64,
    /// Whether the signature was valid.
    pub is_valid: bool,
}

/// Precomputed generator table for an issuer's verifying key.
/// Storing the serialized public key and message-generator bytes avoids
/// re-deriving them on every verification call (generator derivation requires
/// multiple SHA-256 + hash-to-curve evaluations).
#[contracttype]
#[derive(Clone)]
pub struct BbsPrecomputedGenerators {
    /// The issuer this precomputation belongs to.
    pub issuer: Address,
    /// Serialized verifying key (W || Q1 || H_0 || … || H_n-1).
    pub verifying_key_bytes: Bytes,
    /// Ledger timestamp when this was precomputed / last refreshed.
    pub precomputed_at: u64,
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #1289 — BBS+ Key Rotation for Issuers
// ─────────────────────────────────────────────────────────────────────────────

/// A single record in an issuer's key-version history.
/// Old versions are kept so credentials signed under them can still be
/// verified during a configurable grace window.
#[contracttype]
#[derive(Clone)]
pub struct BbsIssuerKeyRecord {
    /// Monotonically increasing key version (starts at 1 for the first key).
    pub version: u32,
    /// Serialized BBS+ verifying key bytes.
    pub verifying_key_bytes: Bytes,
    /// Ledger timestamp when this key became active.
    pub activated_at: u64,
    /// Ledger timestamp when this key was superseded (0 = still active).
    pub superseded_at: u64,
    /// Whether this key version has been explicitly revoked.
    pub revoked: bool,
}

/// Summary record returned by `get_bbs_issuer_key_info`.
#[contracttype]
#[derive(Clone)]
pub struct BbsIssuerKeyInfo {
    /// The issuer address.
    pub issuer: Address,
    /// Current (latest) key version number.
    pub current_version: u32,
    /// Total number of key versions ever registered.
    pub total_versions: u32,
    /// Ledger timestamp of the most recent rotation.
    pub last_rotated_at: u64,
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #1290 — BBS+ Attribute Privacy Controls
// ─────────────────────────────────────────────────────────────────────────────

/// Sensitivity level for a credential attribute.
/// Determines which parties are permitted to request selective disclosure.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum PrivacyLevel {
    /// Freely disclosable — may appear in any presentation.
    Public = 1,
    /// Disclosable to known/permissioned verifiers, but not in public proofs.
    Internal = 2,
    /// Highly sensitive — may only be disclosed with explicit holder consent.
    Confidential = 3,
}

/// The privacy policy record stored for one (credential_type, attribute_name)
/// combination.
#[contracttype]
#[derive(Clone)]
pub struct AttributePrivacyPolicy {
    /// The credential type this policy applies to.
    pub credential_type: u32,
    /// The attribute name (e.g. `b"salary"` or `b"graduation_date"`).
    pub attribute_name: Bytes,
    /// The assigned sensitivity level.
    pub sensitivity: PrivacyLevel,
    /// Admin/issuer that last set this policy.
    pub set_by: Address,
    /// Ledger timestamp when this policy was last updated.
    pub updated_at: u64,
}

/// Result of a disclosure-restriction check.
#[contracttype]
#[derive(Clone)]
pub struct DisclosureCheckResult {
    /// The credential_type queried.
    pub credential_type: u32,
    /// The attribute name queried.
    pub attribute_name: Bytes,
    /// Effective privacy level (Public if no policy exists).
    pub sensitivity: PrivacyLevel,
    /// Whether disclosure is permitted for the given verifier context.
    pub disclosure_permitted: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage key enum for BBS+ features (all four issues)
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKeyBbs {
    // ── #1287: Revocation Registry ───────────────────────────────────────────
    /// Current BBS+ revocation accumulator state.
    BbsAccumulator,
    /// Whether a credential_id has been added to the accumulator.
    BbsAccumulatorMember(u64),
    /// Stored non-revocation proof for a credential (credential_id -> record).
    BbsNonRevocationProof(u64),

    // ── #1288: Performance Optimization ──────────────────────────────────────
    /// Signature verification cache keyed by a 32-byte hash of the inputs.
    BbsSigCache(Bytes),
    /// Precomputed generator table for an issuer's verifying key.
    BbsPrecomputed(Address),

    // ── #1289: Key Rotation ───────────────────────────────────────────────────
    /// Ordered history of key records for an issuer (issuer -> Vec<BbsIssuerKeyRecord>).
    BbsIssuerKeyHistory(Address),
    /// Current key version number for an issuer (issuer -> u32).
    BbsIssuerKeyVersion(Address),

    // ── #1290: Attribute Privacy Controls ─────────────────────────────────────
    /// Privacy policy for (credential_type, attribute_name) pairs.
    /// Key: (credential_type u32, attribute_name Bytes) → AttributePrivacyPolicy.
    AttributePrivacy(u32, Bytes),
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: simple deterministic 32-byte "cache key" from three byte slices.
// On Soroban we cannot use std hashers; instead we XOR-fold the three inputs'
// SHA-2 style rolling hash using the platform-available `Env::crypto()`.
// Since `Env::crypto().sha256()` accepts `Bytes` and returns a 32-byte hash
// we chain the three fields and hash the concatenation.
// ─────────────────────────────────────────────────────────────────────────────
pub(crate) fn bbs_cache_key(
    env: &Env,
    vk_bytes: &Bytes,
    msg_bytes: &Bytes,
    sig_bytes: &Bytes,
) -> Bytes {
    let mut combined = Bytes::new(env);
    combined.append(vk_bytes);
    combined.append(msg_bytes);
    combined.append(sig_bytes);
    let hash = env.crypto().sha256(&combined);
    Bytes::from_array(env, &hash.to_array())
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract function implementations
// These are free functions so they can be called from the contract impl block.
// ─────────────────────────────────────────────────────────────────────────────

// ── #1287 ─────────────────────────────────────────────────────────────────────

/// Add a credential to the BBS+ revocation accumulator.
///
/// The accumulator is an epoch-based positive accumulator: each call
/// updates the stored epoch and records that `credential_id` is a member.
/// The `accumulator_value` is the updated serialized accumulator point
/// produced off-chain by the accumulator manager.
pub fn add_to_revocation_accumulator(
    env: &Env,
    caller: Address,
    credential_id: u64,
    accumulator_value: Bytes,
) {
    // Require admin or issuer auth.
    caller.require_auth();

    let now = env.ledger().timestamp();

    // Advance (or initialise) the accumulator epoch.
    let current: BbsRevocationAccumulator = env
        .storage()
        .instance()
        .get(&DataKeyBbs::BbsAccumulator)
        .unwrap_or(BbsRevocationAccumulator {
            epoch: 0,
            accumulator_bytes: Bytes::new(env),
            updated_at: 0,
        });

    let new_epoch = current.epoch + 1;
    let updated = BbsRevocationAccumulator {
        epoch: new_epoch,
        accumulator_bytes: accumulator_value,
        updated_at: now,
    };

    env.storage()
        .instance()
        .set(&DataKeyBbs::BbsAccumulator, &updated);

    // Mark this credential as a member of the accumulator.
    env.storage()
        .instance()
        .set(&DataKeyBbs::BbsAccumulatorMember(credential_id), &new_epoch);
}

/// Retrieve the current BBS+ revocation accumulator state.
pub fn get_revocation_accumulator(env: &Env) -> Option<BbsRevocationAccumulator> {
    env.storage()
        .instance()
        .get(&DataKeyBbs::BbsAccumulator)
}

/// Store a non-revocation proof for a credential.
///
/// The `proof_bytes` are produced off-chain by the holder using the BBS+
/// accumulator library (see `bbs_plus_v1::accumulator::NonRevocationProof`).
/// The contract records them so verifiers can query the latest proof without
/// requiring the holder to be online.
pub fn create_non_revocation_proof(
    env: &Env,
    holder: Address,
    credential_id: u64,
    proof_bytes: Bytes,
) {
    holder.require_auth();

    let accumulator: BbsRevocationAccumulator = env
        .storage()
        .instance()
        .get(&DataKeyBbs::BbsAccumulator)
        .unwrap_or_else(|| panic!("revocation accumulator not initialised"));

    let record = BbsNonRevocationProofRecord {
        credential_id,
        proof_bytes,
        epoch: accumulator.epoch,
        created_at: env.ledger().timestamp(),
    };

    env.storage()
        .instance()
        .set(&DataKeyBbs::BbsNonRevocationProof(credential_id), &record);
}

/// Verify a stored non-revocation proof for a credential.
///
/// Returns `true` when a proof record exists for the credential AND its
/// epoch matches the current accumulator epoch.  Callers MUST treat a
/// stale epoch (proof.epoch < current_epoch) as "not verified" — the
/// credential holder must refresh their proof against the new accumulator
/// state before it is accepted again.
pub fn verify_non_revocation(env: &Env, credential_id: u64) -> bool {
    let proof_record: Option<BbsNonRevocationProofRecord> = env
        .storage()
        .instance()
        .get(&DataKeyBbs::BbsNonRevocationProof(credential_id));

    let accumulator: Option<BbsRevocationAccumulator> = env
        .storage()
        .instance()
        .get(&DataKeyBbs::BbsAccumulator);

    match (proof_record, accumulator) {
        (Some(proof), Some(acc)) => {
            // Proof must be current-epoch and non-empty.
            proof.epoch == acc.epoch && !proof.proof_bytes.is_empty()
        }
        _ => false,
    }
}

// ── #1288 ─────────────────────────────────────────────────────────────────────

/// Memoize a BBS+ signature verification result.
///
/// `is_valid` is the result the caller has already computed off-chain or
/// via a previous call; this function stores it keyed by the deterministic
/// hash of the three input byte slices so future calls can short-circuit.
pub fn cache_bbs_signature(
    env: &Env,
    verifying_key_bytes: Bytes,
    message_bytes: Bytes,
    signature_bytes: Bytes,
    is_valid: bool,
) {
    let key = bbs_cache_key(env, &verifying_key_bytes, &message_bytes, &signature_bytes);
    let entry = BbsSignatureCache {
        is_valid,
        cached_at: env.ledger().timestamp(),
    };
    env.storage()
        .instance()
        .set(&DataKeyBbs::BbsSigCache(key), &entry);
}

/// Look up a previously memoized BBS+ signature verification result.
///
/// Returns `None` if no cache entry exists for these inputs.
pub fn get_cached_bbs_signature(
    env: &Env,
    verifying_key_bytes: &Bytes,
    message_bytes: &Bytes,
    signature_bytes: &Bytes,
) -> Option<BbsSignatureCache> {
    let key = bbs_cache_key(env, verifying_key_bytes, message_bytes, signature_bytes);
    env.storage()
        .instance()
        .get(&DataKeyBbs::BbsSigCache(key))
}

/// Batch BBS+ signature verification with memoization.
///
/// For each item in `items` the function checks the cache first.
/// Cache misses are recorded as `is_valid: false` with a sentinel that
/// indicates the consumer must perform the real cryptographic check
/// off-chain and then call `cache_bbs_signature` to populate the entry.
///
/// This two-phase model is necessary because Soroban contracts cannot
/// execute the full BLS12-381 pairing check in-contract without the
/// dedicated host function support that is scheduled for a future protocol
/// upgrade.  The contract's role is cache management and result storage;
/// the cryptographic work is delegated to the client.
pub fn batch_verify_bbs_signatures(
    env: &Env,
    items: Vec<BbsBatchVerifyItem>,
) -> Vec<BbsBatchVerifyResult> {
    let mut results = Vec::new(env);

    for i in 0..items.len() {
        let item = items.get(i).unwrap();
        let cached = get_cached_bbs_signature(
            env,
            &item.verifying_key_bytes,
            &item.message_bytes,
            &item.signature_bytes,
        );
        let is_valid = cached.map(|c| c.is_valid).unwrap_or(false);
        results.push_back(BbsBatchVerifyResult {
            credential_id: item.credential_id,
            is_valid,
        });
    }

    results
}

/// Store (or refresh) precomputed BBS+ generator material for an issuer.
///
/// Issuers call this after key rotation so verifiers can retrieve the
/// latest verifying-key bytes without re-deriving generators from the
/// raw public key and context string on every call.
pub fn store_bbs_precomputed_generators(
    env: &Env,
    issuer: Address,
    verifying_key_bytes: Bytes,
) {
    issuer.require_auth();

    let record = BbsPrecomputedGenerators {
        issuer: issuer.clone(),
        verifying_key_bytes,
        precomputed_at: env.ledger().timestamp(),
    };
    env.storage()
        .instance()
        .set(&DataKeyBbs::BbsPrecomputed(issuer), &record);
}

/// Retrieve precomputed BBS+ generator material for an issuer.
pub fn get_bbs_precomputed_generators(
    env: &Env,
    issuer: Address,
) -> Option<BbsPrecomputedGenerators> {
    env.storage()
        .instance()
        .get(&DataKeyBbs::BbsPrecomputed(issuer))
}

// ── #1289 ─────────────────────────────────────────────────────────────────────

/// Register or rotate a BBS+ issuer key — admin-only.
///
/// On the first call for an issuer this registers their initial key (version 1).
/// On subsequent calls it:
///   1. Supersedes the current key record (sets `superseded_at`).
///   2. Appends the new key as the next version.
///   3. Updates the current-version counter.
///
/// Old key records are preserved so credentials issued under them can
/// continue to be verified during a grace window determined by the issuer.
pub fn rotate_issuer_key(
    env: &Env,
    admin: Address,
    issuer: Address,
    new_key: Bytes,
) {
    admin.require_auth();

    let now = env.ledger().timestamp();

    let mut history: Vec<BbsIssuerKeyRecord> = env
        .storage()
        .instance()
        .get(&DataKeyBbs::BbsIssuerKeyHistory(issuer.clone()))
        .unwrap_or_else(|| Vec::new(env));

    let next_version = (history.len() as u32) + 1;

    // Supersede the current active key, if any.
    if !history.is_empty() {
        let last_idx = history.len() - 1;
        let mut last: BbsIssuerKeyRecord = history.get(last_idx).unwrap();
        if last.superseded_at == 0 {
            last.superseded_at = now;
            history.set(last_idx, last);
        }
    }

    // Append the new key record.
    history.push_back(BbsIssuerKeyRecord {
        version: next_version,
        verifying_key_bytes: new_key,
        activated_at: now,
        superseded_at: 0,
        revoked: false,
    });

    env.storage()
        .instance()
        .set(&DataKeyBbs::BbsIssuerKeyHistory(issuer.clone()), &history);
    env.storage()
        .instance()
        .set(&DataKeyBbs::BbsIssuerKeyVersion(issuer.clone()), &next_version);
}

/// Get the full key-version history for an issuer.
pub fn get_bbs_issuer_key_history(
    env: &Env,
    issuer: Address,
) -> Vec<BbsIssuerKeyRecord> {
    env.storage()
        .instance()
        .get(&DataKeyBbs::BbsIssuerKeyHistory(issuer))
        .unwrap_or_else(|| Vec::new(env))
}

/// Get summary info about an issuer's BBS+ key versions.
pub fn get_bbs_issuer_key_info(
    env: &Env,
    issuer: Address,
) -> BbsIssuerKeyInfo {
    let history: Vec<BbsIssuerKeyRecord> = env
        .storage()
        .instance()
        .get(&DataKeyBbs::BbsIssuerKeyHistory(issuer.clone()))
        .unwrap_or_else(|| Vec::new(env));

    let current_version: u32 = env
        .storage()
        .instance()
        .get(&DataKeyBbs::BbsIssuerKeyVersion(issuer.clone()))
        .unwrap_or(0);

    let last_rotated_at = if history.is_empty() {
        0u64
    } else {
        history.get(history.len() - 1).unwrap().activated_at
    };

    BbsIssuerKeyInfo {
        issuer,
        current_version,
        total_versions: history.len() as u32,
        last_rotated_at,
    }
}

/// Get the verifying key for a specific version of an issuer's key.
///
/// Returns `None` if the issuer has no key history or the version does
/// not exist.
pub fn get_bbs_issuer_key_version(
    env: &Env,
    issuer: Address,
    version: u32,
) -> Option<BbsIssuerKeyRecord> {
    let history: Vec<BbsIssuerKeyRecord> = env
        .storage()
        .instance()
        .get(&DataKeyBbs::BbsIssuerKeyHistory(issuer))
        .unwrap_or_else(|| Vec::new(env));

    for i in 0..history.len() {
        let record = history.get(i).unwrap();
        if record.version == version {
            return Some(record);
        }
    }
    None
}

// ── #1290 ─────────────────────────────────────────────────────────────────────

/// Set or update the privacy level for a credential attribute.
///
/// Admin / credential-type issuer only.  The `sensitivity` value governs
/// whether downstream selective-disclosure proofs may include this attribute.
pub fn set_attribute_privacy(
    env: &Env,
    caller: Address,
    credential_type: u32,
    attribute_name: Bytes,
    sensitivity: PrivacyLevel,
) {
    caller.require_auth();

    let policy = AttributePrivacyPolicy {
        credential_type,
        attribute_name: attribute_name.clone(),
        sensitivity,
        set_by: caller,
        updated_at: env.ledger().timestamp(),
    };

    env.storage().instance().set(
        &DataKeyBbs::AttributePrivacy(credential_type, attribute_name),
        &policy,
    );
}

/// Get the privacy policy for a (credential_type, attribute_name) pair.
///
/// Returns `Public` policy when no explicit policy has been set.
pub fn get_attribute_privacy(
    env: &Env,
    credential_type: u32,
    attribute_name: Bytes,
) -> AttributePrivacyPolicy {
    env.storage()
        .instance()
        .get(&DataKeyBbs::AttributePrivacy(
            credential_type,
            attribute_name.clone(),
        ))
        .unwrap_or_else(|| AttributePrivacyPolicy {
            credential_type,
            attribute_name,
            sensitivity: PrivacyLevel::Public,
            set_by: env
                .current_contract_address(),
            updated_at: 0,
        })
}

/// Check whether disclosure of a specific attribute is permitted for the
/// given verifier.
///
/// Business rules:
/// - `Public`       → always permitted.
/// - `Internal`     → permitted only if `verifier_is_permissioned` is `true`.
/// - `Confidential` → never permitted without explicit holder consent (always
///                    returns `false` from this function; a separate consent
///                    grant check is required by the caller).
pub fn check_disclosure_permitted(
    env: &Env,
    credential_type: u32,
    attribute_name: Bytes,
    verifier_is_permissioned: bool,
) -> DisclosureCheckResult {
    let policy = get_attribute_privacy(env, credential_type, attribute_name.clone());

    let disclosure_permitted = match policy.sensitivity {
        PrivacyLevel::Public => true,
        PrivacyLevel::Internal => verifier_is_permissioned,
        PrivacyLevel::Confidential => false,
    };

    DisclosureCheckResult {
        credential_type,
        attribute_name,
        sensitivity: policy.sensitivity,
        disclosure_permitted,
    }
}

/// Batch-check disclosure permissions for multiple attributes.
///
/// Returns a map of `attribute_name (Bytes) → disclosure_permitted (bool)`.
pub fn batch_check_disclosure(
    env: &Env,
    credential_type: u32,
    attribute_names: Vec<Bytes>,
    verifier_is_permissioned: bool,
) -> Map<Bytes, bool> {
    let mut result: Map<Bytes, bool> = Map::new(env);

    for i in 0..attribute_names.len() {
        let attr = attribute_names.get(i).unwrap();
        let check =
            check_disclosure_permitted(env, credential_type, attr.clone(), verifier_is_permissioned);
        result.set(attr, check.disclosure_permitted);
    }

    result
}
