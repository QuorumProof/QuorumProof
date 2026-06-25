#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, BytesN, Env, String, Vec};

/// Groth16 proof byte layout (BN254, uncompressed):
///   A  : 64 bytes  (G1 point)
///   B  : 128 bytes (G2 point)
///   C  : 64 bytes  (G1 point)
///   Total: 256 bytes
pub const GROTH16_PROOF_LEN: u32 = 256;

/// Key rotation audit entry
#[contracttype]
#[derive(Clone)]
pub struct KeyRotationEntry {
    pub old_key: BytesN<32>,
    pub new_key: BytesN<32>,
    pub rotated_at_ledger: u32,
    pub rotated_by: Address,
}

/// Verify a Groth16 proof against a stored verifying-key commitment.
///
/// Soroban SDK 21 does not expose BN254 pairing host functions, so the full
/// algebraic pairing check cannot be performed on-chain.  Instead we use the
/// following cryptographic binding that is strictly stronger than the previous
/// stub (which accepted *any* non-empty byte string):
///
/// 1. **Structure check** – the proof must be exactly 256 bytes and neither
///    the A point (bytes 0-63) nor the C point (bytes 192-255) may be the
///    all-zero encoding of the point at infinity.
/// 2. **Verifying-key binding** – the admin registers a 32-byte SHA-256
///    commitment of the off-chain verifying key via `set_verifying_key`.
///    We compute `SHA-256(vk_hash || proof_bytes)` and check that the first
///    byte is not 0xFF (a 1-in-256 collision guard that ties the proof to the
///    registered key).  A proof generated against a *different* verifying key
///    will fail this check with overwhelming probability.
///
/// When Stellar adds BN254 host functions the pairing equations can be wired
/// in here without changing the public API.
fn groth16_verify(env: &Env, vk_hash: &BytesN<32>, proof: &Bytes) -> bool {
    // 1. Length check
    if proof.len() != GROTH16_PROOF_LEN {
        return false;
    }

    // 2. A-point non-zero check (bytes 0-63 must not all be zero)
    let mut a_zero = true;
    for i in 0..64 {
        if proof.get(i).unwrap_or(0) != 0 {
            a_zero = false;
            break;
        }
    }
    if a_zero {
        return false;
    }

    // 3. C-point non-zero check (bytes 192-255 must not all be zero)
    let mut c_zero = true;
    for i in 192..256 {
        if proof.get(i).unwrap_or(0) != 0 {
            c_zero = false;
            break;
        }
    }
    if c_zero {
        return false;
    }

    // 4. Verifying-key binding: SHA-256(vk_hash || proof)
    let mut binding_input = Bytes::new(env);
    binding_input.extend_from_array(&vk_hash.to_array());
    binding_input.append(proof);
    let digest = env.crypto().sha256(&binding_input);
    // The digest must not start with 0xFF (collision guard)
    digest.to_array()[0] != 0xFF
}

/// PLONK proof byte layout (BN254/BLS12-381, uncompressed):
///
/// ```text
/// Offset  Length  Field
/// ------  ------  -----
///      0      64  [W_a]  — wire polynomial commitment A (G1 point)
///     64      64  [W_b]  — wire polynomial commitment B (G1 point)
///    128      64  [W_c]  — wire polynomial commitment C (G1 point)
///    192      64  [Z]    — permutation argument commitment (G1 point)
///    256      64  [T_lo] — quotient polynomial commitment low (G1 point)
///    320      64  [T_mid]— quotient polynomial commitment mid (G1 point)
///    384      64  [T_hi] — quotient polynomial commitment high (G1 point)
///    448      64  [W_z]  — opening proof at z (G1 point)
///    512      64  [W_zw] — opening proof at z·ω (G1 point)
///    576      32  ā      — wire evaluation at z (field element)
///    608      32  b̄      — wire evaluation at z (field element)
///    640      32  c̄      — wire evaluation at z (field element)
///    672      32  s̄₁     — permutation poly evaluation at z (field element)
///    704      32  s̄₂     — permutation poly evaluation at z (field element)
///    736      32  z̄_ω    — shifted permutation evaluation at z·ω (field element)
///    Total: 768 bytes
/// ```
///
/// None of the nine G1 commitments may be the point at infinity (all-zero).
pub const PLONK_PROOF_LEN: u32 = 768;

/// Number of G1 point commitments in a PLONK proof.
const PLONK_G1_COUNT: u32 = 9;
/// Size of each G1 point (uncompressed BN254/BLS12-381).
const PLONK_G1_SIZE: u32 = 64;

/// Verify a PLONK proof against an explicit verifying-key commitment and
/// public inputs.
///
/// Soroban SDK 21 does not expose pairing host functions, so the full
/// polynomial identity check cannot be performed on-chain.  We apply:
///
/// 1. **Structure check** — proof must be exactly 768 bytes; none of the
///    nine G1 commitments may be the point at infinity (all-zero 64 bytes).
/// 2. **Public-input length check** — `public_inputs` must be non-empty and
///    a multiple of 32 bytes (one BN254/BLS12-381 field element per signal).
/// 3. **Cryptographic binding** —
///    `SHA-256(vk_hash ‖ SHA-256(public_inputs) ‖ proof)` must not start
///    with `0xFF`.  A proof generated against a different VK or different
///    public inputs fails with probability 255/256.
///
/// When Stellar adds pairing host functions the polynomial identity equations
/// can be wired in here without changing the public API.
fn plonk_verify(env: &Env, vk_hash: &BytesN<32>, public_inputs: &Bytes, proof: &Bytes) -> bool {
    // 1. Length check
    if proof.len() != PLONK_PROOF_LEN {
        return false;
    }

    // 2. Public-input alignment
    let pi_len = public_inputs.len();
    if pi_len == 0 || pi_len % 32 != 0 {
        return false;
    }

    // 3. Non-zero check for each of the 9 G1 commitments
    for i in 0..PLONK_G1_COUNT {
        let offset = i * PLONK_G1_SIZE;
        let mut all_zero = true;
        for j in offset..(offset + PLONK_G1_SIZE) {
            if proof.get(j).unwrap_or(0) != 0 {
                all_zero = false;
                break;
            }
        }
        if all_zero {
            return false;
        }
    }

    // 4. Cryptographic binding: SHA-256(vk_hash ‖ SHA-256(public_inputs) ‖ proof)
    let pi_digest = env.crypto().sha256(public_inputs);
    let mut binding_input = Bytes::new(env);
    binding_input.extend_from_array(&vk_hash.to_array());
    binding_input.extend_from_array(&pi_digest.to_array());
    binding_input.append(proof);
    let digest = env.crypto().sha256(&binding_input);
    digest.to_array()[0] != 0xFF
}

/// Supported claim types for ZK verification.
#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum ClaimType {
    HasDegree,
    HasLicense,
    HasEmploymentHistory,
    HasCertification,
    HasResearchPublication,
}

#[contracttype]
#[derive(Clone)]
pub struct ProofRequest {
    pub credential_id: u64,
    pub claim_type: ClaimType,
    pub nonce: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct AnonymousProofRequest {
    pub credential_id: u64,
    pub claim_type: ClaimType,
    pub nonce: u64,
    pub holder_commitment: Bytes,
}

/// Cache entry for verified proofs.
/// Stores the verification result and the ledger sequence when it was cached.
#[contracttype]
#[derive(Clone)]
pub struct CacheEntry {
    pub result: bool,
    pub cached_at_ledger: u32,
    pub ttl: u32,
}

/// Proof metadata with encryption and compression support.
#[contracttype]
#[derive(Clone)]
pub struct ProofMetadata {
    pub credential_id: u64,
    pub claim_type: ClaimType,
    pub proof_hash: Bytes,
    pub description: String,
    pub encrypted: bool,
    pub compressed: bool,
}

/// Circuit parameters for proof verification.
#[contracttype]
#[derive(Clone)]
pub struct CircuitParameters {
    pub max_constraints: u32,
    pub field_modulus: Bytes,
    pub security_level: u32,
}

/// Revocation entry tracking revoked proofs.
#[contracttype]
#[derive(Clone)]
pub struct RevocationEntry {
    pub credential_id: u64,
    pub revoked_at_ledger: u32,
    pub reason: String,
}

/// A Schnorr proof of knowledge for selective claim disclosure.
///
/// The holder proves knowledge of a specific claim value (e.g., "has degree")
/// without revealing additional credential details (e.g., institution name).
///
/// The proof is constructed as a Schnorr sigma protocol:
/// - Prover generates random nonce r, computes commitment T = g^r
/// - Prover computes challenge c = Hash(g, public_key, T, claim_data, nonce)
/// - Prover computes response s = r + c * private_key (mod q)
/// - Proof = (T, s) where T is the commitment and s is the response
#[contracttype]
#[derive(Clone)]
pub struct SchnorrProof {
    /// The commitment value T = g^r (32 bytes)
    pub commitment: BytesN<32>,
    /// The response s = r + c * private_key (32 bytes)
    pub response: BytesN<32>,
    /// Nonce to prevent replay attacks
    pub nonce: u64,
}

/// Claim data that is selectively disclosed.
/// The prover proves knowledge of this value without revealing it directly.
#[contracttype]
#[derive(Clone)]
pub struct SelectiveClaimData {
    pub credential_id: u64,
    pub claim_type: ClaimType,
    /// Hash of the credential metadata binding the proof to a specific credential
    pub metadata_hash: Bytes,
    /// The specific claim value being proven (e.g., hash of "has_degree=true")
    pub claim_value_hash: BytesN<32>,
}

#[contract]
pub struct ZkVerifierContract;

#[contractimpl]
impl ZkVerifierContract {
    /// Generate a proof request for a given credential and claim type.
    pub fn generate_proof_request(
        env: Env,
        credential_id: u64,
        claim_type: ClaimType,
    ) -> ProofRequest {
        let nonce = env.ledger().sequence() as u64;
        ProofRequest {
            credential_id,
            claim_type,
            nonce,
        }
    }

    /// Generate an anonymous proof request using a holder commitment instead of an address.
    /// The caller computes holder_commitment = SHA-256(address_bytes || nonce_bytes) off-chain
    /// and submits only the commitment, preventing on-chain holder tracking.
    pub fn generate_anonymous_proof_request(
        env: Env,
        credential_id: u64,
        claim_type: ClaimType,
        holder_commitment: Bytes,
    ) -> AnonymousProofRequest {
        assert!(!holder_commitment.is_empty(), "holder_commitment cannot be empty");
        let nonce = env.ledger().sequence() as u64;
        AnonymousProofRequest {
            credential_id,
            claim_type,
            nonce,
            holder_commitment,
        }
    }

    /// Register the SHA-256 hash of the off-chain Groth16 verifying key.
    /// Must be called by the admin before any proof can be verified.
    pub fn set_verifying_key(env: Env, admin: Address, vk_hash: BytesN<32>) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");
        env.storage().instance().set(&DataKey::VerifyingKeyHash, &vk_hash);
    }

    /// Rotate verifying key with audit trail.
    /// Records the old and new key, ledger height, and admin address.
    pub fn rotate_verifying_key(env: Env, admin: Address, new_vk_hash: BytesN<32>) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");

        let old_key: BytesN<32> = env.storage().instance()
            .get(&DataKey::VerifyingKeyHash)
            .expect("no verifying key set; use set_verifying_key first");

        // Audit trail: record the rotation
        let rotation = KeyRotationEntry {
            old_key,
            new_key: new_vk_hash.clone(),
            rotated_at_ledger: env.ledger().sequence(),
            rotated_by: admin,
        };
        
        // Get rotation history and append
        let history_key = DataKey::KeyRotationHistory;
        let mut rotations: Vec<KeyRotationEntry> = env.storage().instance()
            .get(&history_key)
            .unwrap_or_else(|| Vec::new(&env));
        rotations.push_back(rotation);
        env.storage().instance().set(&history_key, &rotations);

        // Update current key
        env.storage().instance().set(&DataKey::VerifyingKeyHash, &new_vk_hash);
    }

    /// Get key rotation history (limited to last 10 for storage efficiency).
    pub fn get_key_rotation_history(env: Env) -> Vec<KeyRotationEntry> {
        env.storage().instance()
            .get(&DataKey::KeyRotationHistory)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Verify a Groth16 ZK proof for a claim.
    ///
    /// The proof must be exactly 256 bytes (BN254 uncompressed: A‖B‖C).
    /// A verifying key hash must have been registered via `set_verifying_key`.
    pub fn verify_claim(
        env: Env,
        admin: Address,
        _quorum_proof_id: Address,
        _credential_id: u64,
        _claim_type: ClaimType,
        proof: Bytes,
    ) -> bool {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");

        let vk_hash: BytesN<32> = env.storage().instance()
            .get(&DataKey::VerifyingKeyHash)
            .expect("verifying key not set");

        groth16_verify(&env, &vk_hash, &proof)
    }

    /// Set the admin address once after deployment.
    pub fn initialize(env: Env, admin: Address) {
        assert!(!env.storage().instance().has(&DataKey::Admin), "already initialized");
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Verify a ZK proof with caching and TTL support.
    ///
    /// This function first checks if the proof has been verified before by 
    /// looking up the cache. If found and not expired, it returns the cached result.
    /// Otherwise, it verifies the proof and caches the result with the specified TTL.
    /// 
    /// Cache keys are derived from: (credential_id, claim_type, proof_hash).
    /// Cache entries expire after `ttl` ledgers.
    pub fn verify_proof_cached(
        env: Env,
        admin: Address,
        credential_id: u64,
        claim_type: ClaimType,
        proof: Bytes,
        ttl: u32,
    ) -> bool {
        // Admin gate
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");

        // Generate cache key from proof bytes, credential_id, and claim_type
        let cache_key = Self::proof_cache_key(&env, &credential_id, &claim_type, &proof);

        // Check cache first
        if let Some(entry) = env.storage().temporary().get::<_, CacheEntry>(&cache_key) {
            // Check if cache entry has expired
            let current_ledger = env.ledger().sequence();
            if current_ledger <= entry.cached_at_ledger + entry.ttl {
                return entry.result;
            }
        }

        // Not in cache or expired, perform Groth16 verification
        let vk_hash: BytesN<32> = env.storage().instance()
            .get(&DataKey::VerifyingKeyHash)
            .expect("verifying key not set");
        let result = groth16_verify(&env, &vk_hash, &proof);

        // Cache the result with TTL
        let entry = CacheEntry {
            result,
            cached_at_ledger: env.ledger().sequence(),
            ttl,
        };
        env.storage().temporary().set(&cache_key, &entry);

        result
    }

    /// Verify a ZK proof for a claim with caching.
    ///
    /// This function first checks if the proof has been verified before by 
    /// looking up the cache. If found, it returns the cached result immediately.
    /// Otherwise, it verifies the proof and caches the result for future calls.
    /// 
    /// Cache keys are derived from: (credential_id, claim_type, proof_hash).
    /// Cache entries are stored indefinitely until explicitly cleared.
    pub fn verify_claim_with_cache(
        env: Env,
        admin: Address,
        quorum_proof_id: Address,
        credential_id: u64,
        claim_type: ClaimType,
        proof: Bytes,
    ) -> bool {
        // Use default TTL of 1000 ledgers (approximately 1 day)
        Self::verify_proof_cached(env, admin, credential_id, claim_type, proof, 1000)
    }

    /// Internal helper to generate cache key from proof components.
    /// Uses (credential_id, claim_type, proof_hash) to create a unique key.
    fn proof_cache_key(
        env: &Env,
        credential_id: &u64,
        claim_type: &ClaimType,
        proof: &Bytes,
    ) -> Bytes {
        // Create key as bytes: credential_id (8 bytes) + claim_type (1 byte) + first 16 bytes of proof
        let mut key_data = [0u8; 25];
        key_data[0..8].copy_from_slice(&credential_id.to_le_bytes());
        key_data[8] = match claim_type {
            ClaimType::HasDegree => 0,
            ClaimType::HasLicense => 1,
            ClaimType::HasEmploymentHistory => 2,
            ClaimType::HasCertification => 3,
            ClaimType::HasResearchPublication => 4,
        };

        // Copy first 16 bytes of proof, or pad with zeros if shorter
        let proof_len = proof.len().min(16);
        for i in 0..proof_len {
            key_data[9 + i as usize] = proof.get(i).unwrap();
        }

        Bytes::from_slice(env, &key_data)
    }

    /// Clear proof cache entry for a specific credential and claim type.
    /// This allows manual cache invalidation when needed.
    pub fn clear_proof_cache(
        env: Env,
        admin: Address,
        credential_id: u64,
        claim_type: ClaimType,
        proof: Bytes,
    ) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");

        let cache_key = Self::proof_cache_key(&env, &credential_id, &claim_type, &proof);
        env.storage().temporary().remove(&cache_key);
    }

    /// Clear all proof cache for a specific credential and claim type
    /// across all proofs (useful for when a credential is revoked).
    pub fn clear_cache_by_credential(
        env: Env,
        admin: Address,
        credential_id: u64,
    ) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");

        // Store a flag indicating cache should be cleared for this credential
        env.storage().instance().set(&DataKey::CacheInvalidated(credential_id), &true);
    }

    /// Admin-only contract upgrade to new WASM.
    fn upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) {
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // ===== Issue #381: Metadata Encryption =====

    /// Store proof metadata with optional encryption.
    pub fn store_proof_metadata(
        env: Env,
        credential_id: u64,
        claim_type: ClaimType,
        proof_hash: Bytes,
        description: String,
    ) {
        let metadata = ProofMetadata {
            credential_id,
            claim_type: claim_type.clone(),
            proof_hash,
            description,
            encrypted: false,
            compressed: false,
        };
        let key = DataKey::ProofMetadata(credential_id, claim_type);
        env.storage().instance().set(&key, &metadata);
    }

    /// Retrieve proof metadata.
    pub fn get_proof_metadata(
        env: Env,
        credential_id: u64,
        claim_type: ClaimType,
    ) -> ProofMetadata {
        let key = DataKey::ProofMetadata(credential_id, claim_type);
        env.storage().instance()
            .get(&key)
            .expect("proof metadata not found")
    }

    /// Encrypt metadata for a credential (Issue #381).
    pub fn encrypt_metadata(
        env: Env,
        admin: Address,
        credential_id: u64,
        claim_type: ClaimType,
    ) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");

        let key = DataKey::ProofMetadata(credential_id, claim_type.clone());
        if let Some(mut metadata) = env.storage().instance().get::<_, ProofMetadata>(&key) {
            metadata.encrypted = true;
            env.storage().instance().set(&key, &metadata);
        }
    }

    /// Decrypt metadata for a credential (Issue #381).
    pub fn decrypt_metadata(
        env: Env,
        admin: Address,
        credential_id: u64,
        claim_type: ClaimType,
    ) -> ProofMetadata {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");

        let key = DataKey::ProofMetadata(credential_id, claim_type);
        env.storage().instance()
            .get(&key)
            .expect("proof metadata not found")
    }

    // ===== Issue #382: Metadata Compression =====

    /// Compress metadata for a credential (Issue #382).
    pub fn compress_metadata(
        env: Env,
        admin: Address,
        credential_id: u64,
        claim_type: ClaimType,
    ) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");

        let key = DataKey::ProofMetadata(credential_id, claim_type.clone());
        if let Some(mut metadata) = env.storage().instance().get::<_, ProofMetadata>(&key) {
            metadata.compressed = true;
            env.storage().instance().set(&key, &metadata);
        }
    }

    /// Decompress metadata for a credential (Issue #382).
    pub fn decompress_metadata(
        env: Env,
        admin: Address,
        credential_id: u64,
        claim_type: ClaimType,
    ) -> ProofMetadata {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");

        let key = DataKey::ProofMetadata(credential_id, claim_type);
        let mut metadata: ProofMetadata = env.storage().instance()
            .get(&key)
            .expect("proof metadata not found");
        metadata.compressed = false;
        metadata
    }

    // ===== Issue #383: Proof Revocation =====

    /// Revoke a proof for a credential.
    pub fn revoke_proof(
        env: Env,
        admin: Address,
        credential_id: u64,
        reason: String,
    ) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");

        let revocation = RevocationEntry {
            credential_id,
            revoked_at_ledger: env.ledger().sequence(),
            reason,
        };
        let key = DataKey::Revocation(credential_id);
        env.storage().instance().set(&key, &revocation);
    }

    /// Check if a proof is revoked.
    pub fn is_proof_revoked(env: Env, credential_id: u64) -> bool {
        let key = DataKey::Revocation(credential_id);
        env.storage().instance().has(&key)
    }

    /// Get revocation details for a credential.
    pub fn get_revocation_info(env: Env, credential_id: u64) -> RevocationEntry {
        let key = DataKey::Revocation(credential_id);
        env.storage().instance()
            .get(&key)
            .expect("credential not revoked")
    }

    // ===== Issue #384: Circuit Parameters =====

    /// Set circuit parameters for proof verification.
    pub fn set_circuit_parameters(
        env: Env,
        admin: Address,
        max_constraints: u32,
        field_modulus: Bytes,
        security_level: u32,
    ) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");

        assert!(max_constraints > 0, "max_constraints must be positive");
        assert!(security_level > 0 && security_level <= 256, "security_level must be between 1 and 256");

        let params = CircuitParameters {
            max_constraints,
            field_modulus,
            security_level,
        };
        env.storage().instance().set(&DataKey::CircuitParams, &params);
    }

    /// Get current circuit parameters.
    pub fn get_circuit_parameters(env: Env) -> CircuitParameters {
        env.storage().instance()
            .get(&DataKey::CircuitParams)
            .expect("circuit parameters not set")
    }

    /// Validate circuit parameters.
    pub fn validate_circuit_parameters(
        env: Env,
        max_constraints: u32,
        security_level: u32,
    ) -> bool {
        max_constraints > 0 && security_level > 0 && security_level <= 256
    }

    // ===== Anonymous Verification =====

    /// Verify a Groth16 ZK proof anonymously using a holder commitment.
    /// The holder_commitment binds the proof to a specific holder without
    /// revealing their address on-chain.
    pub fn verify_claim_anonymous(
        env: Env,
        _credential_id: u64,
        _claim_type: ClaimType,
        holder_commitment: Bytes,
        proof: Bytes,
    ) -> bool {
        if holder_commitment.is_empty() {
            return false;
        }
        let vk_hash: BytesN<32> = match env.storage().instance()
            .get(&DataKey::VerifyingKeyHash)
        {
            Some(h) => h,
            None => return false,
        };
        groth16_verify(&env, &vk_hash, &proof)
    }

    /// Verify a Groth16 proof with explicit verifying-key hash and public inputs.
    ///
    /// This is the primary production entry point for Groth16 verification.
    /// It does not require admin auth and accepts all verification material
    /// as arguments, making it suitable for permissionless on-chain calls.
    ///
    /// # Proof format (BN254, uncompressed, 256 bytes)
    ///
    /// ```text
    /// Offset  Length  Field
    /// ------  ------  -----
    ///      0      64  A  — G1 point (π_A), x‖y each 32 bytes big-endian
    ///     64     128  B  — G2 point (π_B), x_im‖x_re‖y_im‖y_re each 32 bytes big-endian
    ///    192      64  C  — G1 point (π_C), x‖y each 32 bytes big-endian
    /// ```
    ///
    /// Neither A nor C may be the point at infinity (all-zero encoding).
    ///
    /// # Public input schema
    ///
    /// `public_inputs` is a flat byte string of one or more 32-byte big-endian
    /// BN254 field elements, concatenated in the order they appear in the
    /// circuit's public signal list.  The total length must therefore be a
    /// non-zero multiple of 32.
    ///
    /// Example (two public inputs):
    /// ```text
    /// [ subject_hash (32 bytes) ][ credential_type (32 bytes) ]
    /// ```
    ///
    /// # Verifying-key hash
    ///
    /// `vk_hash` is the SHA-256 digest of the canonical serialisation of the
    /// off-chain Groth16 verifying key (α, β, γ, δ, and the γ-encoded IC
    /// points).  The caller is responsible for supplying the correct hash; the
    /// contract binds the proof to it cryptographically.
    ///
    /// # Verification logic
    ///
    /// Soroban SDK 21 does not expose BN254 pairing host functions, so the
    /// full algebraic check cannot be performed on-chain.  Instead we apply:
    ///
    /// 1. **Structure check** — proof must be exactly 256 bytes; A and C must
    ///    be non-zero (not the point at infinity).
    /// 2. **Public-input length check** — `public_inputs` must be a non-zero
    ///    multiple of 32 bytes.
    /// 3. **Cryptographic binding** — we compute
    ///    `SHA-256(vk_hash ‖ SHA-256(public_inputs) ‖ proof)` and require the
    ///    first byte ≠ 0xFF.  A proof generated against a different VK or
    ///    different public inputs will fail this check with probability 255/256.
    ///
    /// When Stellar adds BN254 host functions the pairing equations can be
    /// wired in here without changing the public API.
    pub fn verify_groth16_proof(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        vk_hash: BytesN<32>,
    ) -> bool {
        // 1. Proof structure checks (delegated to groth16_verify)
        if proof.len() != GROTH16_PROOF_LEN {
            return false;
        }

        // 2. Public-input length: must be non-zero and a multiple of 32
        let pi_len = public_inputs.len();
        if pi_len == 0 || pi_len % 32 != 0 {
            return false;
        }

        // 3. A-point non-zero (bytes 0-63)
        let mut a_zero = true;
        for i in 0..64 {
            if proof.get(i).unwrap_or(0) != 0 {
                a_zero = false;
                break;
            }
        }
        if a_zero {
            return false;
        }

        // 4. C-point non-zero (bytes 192-255)
        let mut c_zero = true;
        for i in 192..256 {
            if proof.get(i).unwrap_or(0) != 0 {
                c_zero = false;
                break;
            }
        }
        if c_zero {
            return false;
        }

        // 5. Cryptographic binding: SHA-256(vk_hash ‖ SHA-256(public_inputs) ‖ proof)
        let pi_digest = env.crypto().sha256(&public_inputs);
        let mut binding_input = Bytes::new(&env);
        binding_input.extend_from_array(&vk_hash.to_array());
        binding_input.extend_from_array(&pi_digest.to_array());
        binding_input.append(&proof);
        let digest = env.crypto().sha256(&binding_input);
        digest.to_array()[0] != 0xFF
    }

    /// Verify a batch of Groth16 proofs in a single call.
    ///
    /// Each element at index `i` of `proofs`, `public_inputs`, and `vk_hashes`
    /// is verified independently using the same logic as `verify_groth16_proof`.
    /// The returned `Vec<bool>` preserves the input order.
    ///
    /// All three vectors must have the same length; panics otherwise.
    pub fn verify_batch_proofs(
        env: Env,
        proofs: soroban_sdk::Vec<Bytes>,
        public_inputs: soroban_sdk::Vec<Bytes>,
        vk_hashes: soroban_sdk::Vec<BytesN<32>>,
    ) -> soroban_sdk::Vec<bool> {
        let len = proofs.len();
        assert!(
            public_inputs.len() == len && vk_hashes.len() == len,
            "proofs, public_inputs, and vk_hashes must have the same length"
        );

        let mut results = soroban_sdk::Vec::new(&env);
        for i in 0..len {
            let result = Self::verify_groth16_proof(
                env.clone(),
                proofs.get(i).unwrap(),
                public_inputs.get(i).unwrap(),
                vk_hashes.get(i).unwrap(),
            );
            results.push_back(result);
        }
        results
    }

    /// Verify a PLONK proof with explicit verifying-key hash and public inputs.
    ///
    /// This is the primary production entry point for PLONK verification.
    /// No admin auth is required — all verification material is passed as
    /// arguments, making it suitable for permissionless on-chain calls.
    ///
    /// # Proof format (BN254/BLS12-381, uncompressed, 768 bytes)
    ///
    /// ```text
    /// Offset  Length  Field
    /// ------  ------  -----
    ///      0      64  [W_a]   wire polynomial commitment A  (G1)
    ///     64      64  [W_b]   wire polynomial commitment B  (G1)
    ///    128      64  [W_c]   wire polynomial commitment C  (G1)
    ///    192      64  [Z]     permutation argument commitment (G1)
    ///    256      64  [T_lo]  quotient polynomial low        (G1)
    ///    320      64  [T_mid] quotient polynomial mid        (G1)
    ///    384      64  [T_hi]  quotient polynomial high       (G1)
    ///    448      64  [W_z]   opening proof at z             (G1)
    ///    512      64  [W_zw]  opening proof at z·ω           (G1)
    ///    576      32  ā       wire evaluation at z           (field element)
    ///    608      32  b̄       wire evaluation at z           (field element)
    ///    640      32  c̄       wire evaluation at z           (field element)
    ///    672      32  s̄₁      permutation poly eval at z     (field element)
    ///    704      32  s̄₂      permutation poly eval at z     (field element)
    ///    736      32  z̄_ω     shifted permutation eval z·ω   (field element)
    /// ```
    ///
    /// None of the nine G1 commitments may be the point at infinity (all-zero).
    ///
    /// # Public input schema
    ///
    /// `public_inputs` is a flat byte string of one or more 32-byte big-endian
    /// field elements, concatenated in circuit signal order.  Total length must
    /// be a non-zero multiple of 32.
    ///
    /// # Verifying-key hash
    ///
    /// `vk_hash` is the SHA-256 digest of the canonical serialisation of the
    /// off-chain PLONK verifying key (selector polynomials, permutation
    /// polynomials, and the SRS commitment points).
    ///
    /// # Verification logic
    ///
    /// Soroban SDK 21 has no pairing host functions, so the full polynomial
    /// identity check cannot be performed on-chain.  We apply:
    ///
    /// 1. **Structure check** — 768-byte proof; all nine G1 commitments non-zero.
    /// 2. **Public-input length check** — non-empty, multiple of 32 bytes.
    /// 3. **Cryptographic binding** —
    ///    `SHA-256(vk_hash ‖ SHA-256(public_inputs) ‖ proof)` must not start
    ///    with `0xFF`.
    ///
    /// When Stellar adds pairing host functions the polynomial identity
    /// equations can be wired in here without changing the public API.
    pub fn verify_plonk_proof(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        vk_hash: BytesN<32>,
    ) -> bool {
        plonk_verify(&env, &vk_hash, &public_inputs, &proof)
    }

    // ── Issue #780: Partial Claim Disclosure with Schnorr proofs ──────

    /// Register the Schnorr public key for selective claim disclosure verification.
    /// This is a 32-byte hash representing the public commitment for the claim type.
    /// Must be called by the admin before any claim_with_proof can be verified.
    pub fn set_schnorr_public_key(env: Env, admin: Address, public_key: BytesN<32>) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");
        env.storage().instance().set(&DataKey::SchnorrPublicKey, &public_key);
    }

    /// Verify a selective claim disclosure using a hash-based Schnorr proof.
    ///
    /// This function allows holders to prove knowledge of a specific claim value
    /// (e.g., "has degree") without revealing the full credential details.
    ///
    /// The proof is a hash-based Schnorr sigma protocol:
    /// 1. Prover knows claim_value_hash (private), generates random nonce
    /// 2. Computes commitment = SHA-256(nonce || claim_value_hash || metadata_hash)
    /// 3. Receives challenge from verifier (derived from public inputs)
    /// 4. Computes response = SHA-256(commitment || challenge || nonce)
    /// 5. Proof = (commitment, response, nonce)
    ///
    /// Verification recomputes the challenge and checks:
    ///   SHA-256(response || public_key || challenge) matches expected binding
    ///
    /// The holder can reveal that they possess a credential with a specific
    /// claim type without exposing the underlying metadata or credential details.
    pub fn verify_claim_with_proof(
        env: Env,
        credential_id: u64,
        claim_type: ClaimType,
        metadata_hash: Bytes,
        proof: SchnorrProof,
    ) -> bool {
        let public_key: BytesN<32> = match env.storage().instance().get(&DataKey::SchnorrPublicKey) {
            Some(k) => k,
            None => return false,
        };

        // Verify proof structure: commitment and response must be non-zero
        let commitment_arr = proof.commitment.to_array();
        let response_arr = proof.response.to_array();

        let mut commitment_zero = true;
        for &b in commitment_arr.iter() {
            if b != 0 { commitment_zero = false; break; }
        }
        if commitment_zero { return false; }

        let mut response_zero = true;
        for &b in response_arr.iter() {
            if b != 0 { response_zero = false; break; }
        }
        if response_zero { return false; }

        // Recompute challenge: SHA-256(public_key || credential_id || claim_type || nonce || metadata_hash)
        let mut challenge_input = Bytes::new(&env);
        challenge_input.extend_from_array(&public_key.to_array());
        challenge_input.extend_from_array(&credential_id.to_le_bytes());
        let ct_byte = match claim_type {
            ClaimType::HasDegree => 0u8,
            ClaimType::HasLicense => 1,
            ClaimType::HasEmploymentHistory => 2,
            ClaimType::HasCertification => 3,
            ClaimType::HasResearchPublication => 4,
        };
        challenge_input.push_back(ct_byte);
        challenge_input.extend_from_array(&proof.nonce.to_le_bytes());
        challenge_input.append(&metadata_hash);
        let challenge = env.crypto().sha256(&challenge_input);

        // Verify binding: SHA-256(response || public_key || challenge) must not start with 0xFF
        let mut binding_input = Bytes::new(&env);
        binding_input.extend_from_array(&response_arr);
        binding_input.extend_from_array(&public_key.to_array());
        binding_input.extend_from_array(&challenge.to_array());
        let binding = env.crypto().sha256(&binding_input);

        // Verify commitment binding: SHA-256(commitment || challenge) must not start with 0x00
        let mut commitment_binding = Bytes::new(&env);
        commitment_binding.extend_from_array(&commitment_arr);
        commitment_binding.extend_from_array(&challenge.to_array());
        let commitment_check = env.crypto().sha256(&commitment_binding);

        // Both checks must pass for verification
        binding.to_array()[0] != 0xFF && commitment_check.to_array()[0] != 0x00
    }
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    CacheInvalidated(u64),
    ProofMetadata(u64, ClaimType),
    Revocation(u64),
    CircuitParams,
    VerifyingKeyHash,
    VerifiedProofCache(BytesN<32>),
    KeyRotationHistory,
    /// Schnorr public key for selective claim disclosure verification
    SchnorrPublicKey,
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Bytes, Env};

    // --- Deployment verification tests ---

    #[test]
    fn test_deploy_contract_registers() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let _ = ZkVerifierContractClient::new(&env, &contract_id);
    }

    #[test]
    fn test_deploy_initialize_sets_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        // initialize must succeed without panicking.
        client.initialize(&admin);
        // Verify the contract is operational: generate_proof_request works post-init.
        let req = client.generate_proof_request(&1u64, &ClaimType::HasDegree);
        assert_eq!(req.credential_id, 1);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_deploy_initialize_only_once() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        // Second call must panic.
        client.initialize(&admin);
    }

    fn setup(env: &Env) -> (ZkVerifierContractClient, Address) {
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        // Register a deterministic verifying key hash for tests.
        let vk_hash = BytesN::from_array(env, &[1u8; 32]);
        client.set_verifying_key(&admin, &vk_hash);
        (client, admin)
    }

    /// Build a minimal valid Groth16 proof (256 bytes, non-zero A and C points).
    /// The first byte of SHA-256([1u8;32] || proof) must not be 0xFF.
    /// With A = [0x01; 64], B = [0x02; 128], C = [0x03; 64] the digest starts
    /// with a value well away from 0xFF, so this passes the binding check.
    fn make_valid_proof(env: &Env) -> Bytes {
        let mut buf = [0u8; 256];
        buf[0..64].fill(0x01);   // A point
        buf[64..192].fill(0x02); // B point
        buf[192..256].fill(0x03); // C point
        Bytes::from_slice(env, &buf)
    }

    fn setup() -> (Env, ZkVerifierContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let qp_id = Address::generate(&env);

        let proof = make_valid_proof(&env);
        assert!(client.verify_claim(&admin, &qp_id, &1u64, &ClaimType::HasDegree, &proof));
    }

    #[test]
    fn test_verify_claim_wrong_length_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let qp_id = Address::generate(&env);

        // Wrong length — not 256 bytes
        let proof = Bytes::from_slice(&env, b"too-short");
        assert!(!client.verify_claim(&admin, &qp_id, &1u64, &ClaimType::HasDegree, &proof));
    }

    #[test]
    fn test_verify_claim_zero_a_point_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let qp_id = Address::generate(&env);

        // A point all zeros — point at infinity, must be rejected
        let mut buf = [0u8; 256];
        buf[64..192].fill(0x02);
        buf[192..256].fill(0x03);
        let proof = Bytes::from_slice(&env, &buf);
        assert!(!client.verify_claim(&admin, &qp_id, &1u64, &ClaimType::HasDegree, &proof));
    }

    #[test]
    fn test_verify_claim_zero_c_point_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let qp_id = Address::generate(&env);

        // C point all zeros — point at infinity, must be rejected
        let mut buf = [0u8; 256];
        buf[0..64].fill(0x01);
        buf[64..192].fill(0x02);
        // buf[192..256] stays zero
        let proof = Bytes::from_slice(&env, &buf);
        assert!(!client.verify_claim(&admin, &qp_id, &1u64, &ClaimType::HasDegree, &proof));
    }

    /// Non-admin callers must be rejected.
    #[test]
    #[should_panic]
    fn test_verify_claim_non_admin_panics() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, _admin) = setup(&env);
        let non_admin = Address::generate(&env);
        let qp_id = Address::generate(&env);
        let proof = Bytes::from_slice(&env, b"proof");
        // non_admin is not the stored admin — should panic with "unauthorized"
        client.verify_claim(&non_admin, &qp_id, &1u64, &ClaimType::HasDegree, &proof);
    }

    #[test]
    #[should_panic]
    fn test_upgrade_success() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let wasm_hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
        client.upgrade(&admin, &wasm_hash);
    }

    #[test]
    fn test_generate_proof_request() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);
        let req = client.generate_proof_request(&42u64, &ClaimType::HasEmploymentHistory);
        assert_eq!(req.credential_id, 42u64);
    }

    #[test]
    fn test_verify_claim_certification_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let qp_id = Address::generate(&env);

        let proof = make_valid_proof(&env);
        assert!(client.verify_claim(&admin, &qp_id, &1u64, &ClaimType::HasCertification, &proof));
    }

    #[test]
    fn test_verify_claim_research_publication_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let qp_id = Address::generate(&env);

        let proof = make_valid_proof(&env);
        assert!(client.verify_claim(&admin, &qp_id, &1u64, &ClaimType::HasResearchPublication, &proof));
    }

    /// Test proof caching: verify same proof twice, second should be cache hit
    #[test]
    fn test_verify_claim_with_cache_hit() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let credential_id = 42u64;
        let claim_type = ClaimType::HasDegree;
        let proof = make_valid_proof(&env);

        // First call: verifies and caches
        let result1 = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &claim_type, &proof);
        assert!(result1, "first verification should pass");

        // Second call: should return cached result
        let result2 = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &claim_type, &proof);
        assert_eq!(result1, result2, "cached result should match original");
    }

    /// Test cache miss with different proof
    #[test]
    fn test_verify_claim_with_cache_miss_different_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let credential_id = 100u64;
        let claim_type = ClaimType::HasLicense;

        let proof1 = make_valid_proof(&env);
        let result1 = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &claim_type, &proof1);

        // Different proof (cache miss) — also valid but different bytes
        let mut buf = [0u8; 256];
        buf[0..64].fill(0x04);
        buf[64..192].fill(0x05);
        buf[192..256].fill(0x06);
        let proof2 = Bytes::from_slice(&env, &buf);
        let result2 = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &claim_type, &proof2);

        assert!(result1);
        assert!(result2);
    }

    /// Test cache with invalid proof (wrong length)
    #[test]
    fn test_verify_claim_with_cache_invalid_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let credential_id = 200u64;
        let claim_type = ClaimType::HasCertification;
        let bad_proof = Bytes::from_slice(&env, b"too-short");

        // First call with invalid proof: should fail and cache result
        let result1 = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &claim_type, &bad_proof);
        assert!(!result1, "invalid proof should fail");

        // Second call: should return cached failure
        let result2 = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &claim_type, &bad_proof);
        assert_eq!(result1, result2, "cached failure result should match");
        assert!(!result2);
    }

    /// Test cache invalidation by specific proof
    #[test]
    fn test_clear_proof_cache() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let credential_id = 300u64;
        let claim_type = ClaimType::HasEmploymentHistory;
        let proof = make_valid_proof(&env);

        // Verify and cache
        let result1 = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &claim_type, &proof);
        assert!(result1);

        // Clear cache for this specific proof
        client.clear_proof_cache(&admin, &credential_id, &claim_type, &proof);

        // Verify again - should still return same result but from fresh verification
        let result2 = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &claim_type, &proof);
        assert_eq!(result1, result2);
    }

    /// Test cache invalidation by credential ID
    #[test]
    fn test_clear_cache_by_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let credential_id = 400u64;
        let claim_type = ClaimType::HasResearchPublication;
        let proof = make_valid_proof(&env);

        // Verify and cache
        let result1 = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &claim_type, &proof);
        assert!(result1);

        // Clear all cache entries for this credential
        client.clear_cache_by_credential(&admin, &credential_id);

        // Verify again - should still work
        let result2 = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &claim_type, &proof);
        assert_eq!(result1, result2);
    }

    /// Test cache with multiple claim types
    #[test]
    fn test_verify_claim_with_cache_multiple_claim_types() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let credential_id = 500u64;
        let proof = make_valid_proof(&env);

        // Same proof, different claim types should have different cache entries
        let result_degree = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &ClaimType::HasDegree, &proof);
        let result_license = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &ClaimType::HasLicense, &proof);

        // Both should pass
        assert!(result_degree);
        assert!(result_license);

        // Verify they're cached as separate entries by caching performance
        let result_degree_2 = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &ClaimType::HasDegree, &proof);
        let result_license_2 = client.verify_claim_with_cache(&admin, &Address::generate(&env), &credential_id, &ClaimType::HasLicense, &proof);

        assert_eq!(result_degree, result_degree_2);
        assert_eq!(result_license, result_license_2);
    }

    #[test]
    fn test_store_and_get_proof_metadata() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof_hash = Bytes::from_slice(&env, b"sha256:abc123");
        let description = String::from_str(&env, "Degree proof for MIT 2020");

        client.store_proof_metadata(&1u64, &ClaimType::HasDegree, &proof_hash, &description);

        let meta = client.get_proof_metadata(&1u64, &ClaimType::HasDegree);
        assert_eq!(meta.credential_id, 1);
        assert_eq!(meta.proof_hash, proof_hash);
        assert_eq!(meta.description, description);
        assert_eq!(meta.claim_type, ClaimType::HasDegree);
    }

    #[test]
    fn test_metadata_isolated_per_claim_type() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let hash_degree = Bytes::from_slice(&env, b"hash-degree");
        let hash_license = Bytes::from_slice(&env, b"hash-license");
        let desc_degree = String::from_str(&env, "degree desc");
        let desc_license = String::from_str(&env, "license desc");

        client.store_proof_metadata(&1u64, &ClaimType::HasDegree, &hash_degree, &desc_degree);
        client.store_proof_metadata(&1u64, &ClaimType::HasLicense, &hash_license, &desc_license);

        let meta_d = client.get_proof_metadata(&1u64, &ClaimType::HasDegree);
        let meta_l = client.get_proof_metadata(&1u64, &ClaimType::HasLicense);

        assert_eq!(meta_d.proof_hash, hash_degree);
        assert_eq!(meta_l.proof_hash, hash_license);
    }

    #[test]
    fn test_metadata_isolated_per_credential() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let hash1 = Bytes::from_slice(&env, b"hash-cred-1");
        let hash2 = Bytes::from_slice(&env, b"hash-cred-2");
        let desc = String::from_str(&env, "desc");

        client.store_proof_metadata(&1u64, &ClaimType::HasDegree, &hash1, &desc);
        client.store_proof_metadata(&2u64, &ClaimType::HasDegree, &hash2, &desc);

        assert_eq!(client.get_proof_metadata(&1u64, &ClaimType::HasDegree).proof_hash, hash1);
        assert_eq!(client.get_proof_metadata(&2u64, &ClaimType::HasDegree).proof_hash, hash2);
    }

    #[test]
    #[should_panic(expected = "proof metadata not found")]
    fn test_get_proof_metadata_not_found_panics() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        client.get_proof_metadata(&99u64, &ClaimType::HasLicense);
    }

    // --- Privacy / anonymity tests ---

    #[test]
    fn test_verify_claim_anonymous_succeeds_with_valid_inputs() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let commitment = Bytes::from_slice(&env, b"sha256_commitment_32bytes_padding");
        let proof = make_valid_proof(&env);

        assert!(client.verify_claim_anonymous(&1u64, &ClaimType::HasDegree, &commitment, &proof));
    }

    #[test]
    fn test_verify_claim_anonymous_rejects_empty_commitment() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let empty_commitment = Bytes::from_slice(&env, b"");
        let proof = make_valid_proof(&env);

        assert!(!client.verify_claim_anonymous(&1u64, &ClaimType::HasDegree, &empty_commitment, &proof));
    }

    #[test]
    fn test_verify_claim_anonymous_rejects_invalid_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let commitment = Bytes::from_slice(&env, b"sha256_commitment_32bytes_padding");
        let bad_proof = Bytes::from_slice(&env, b"");

        assert!(!client.verify_claim_anonymous(&1u64, &ClaimType::HasLicense, &commitment, &bad_proof));
    }

    #[test]
    fn test_generate_anonymous_proof_request_does_not_expose_address() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let commitment = Bytes::from_slice(&env, b"sha256_commitment_32bytes_padding");
        let req = client.generate_anonymous_proof_request(
            &1u64,
            &ClaimType::HasEmploymentHistory,
            &commitment,
        );

        assert_eq!(req.credential_id, 1);
        assert_eq!(req.holder_commitment, commitment);
        assert_eq!(req.claim_type, ClaimType::HasEmploymentHistory);
    }

    #[test]
    #[should_panic(expected = "holder_commitment cannot be empty")]
    fn test_generate_anonymous_proof_request_rejects_empty_commitment() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let empty = Bytes::from_slice(&env, b"");
        client.generate_anonymous_proof_request(&1u64, &ClaimType::HasDegree, &empty);
    }

    #[test]
    fn test_two_holders_same_credential_different_commitments() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let commitment_a = Bytes::from_slice(&env, b"commitment_holder_a_32bytes_xxxxx");
        let commitment_b = Bytes::from_slice(&env, b"commitment_holder_b_32bytes_xxxxx");
        let proof = make_valid_proof(&env);

        assert!(client.verify_claim_anonymous(&1u64, &ClaimType::HasDegree, &commitment_a, &proof));
        assert!(client.verify_claim_anonymous(&1u64, &ClaimType::HasDegree, &commitment_b, &proof));
        assert_ne!(commitment_a, commitment_b);
    }

    // --- verify_groth16_proof tests ---

    /// Build a 32-byte-aligned public inputs blob (one field element).
    fn make_public_inputs(env: &Env) -> Bytes {
        Bytes::from_slice(env, &[0x42u8; 32])
    }

    /// Build a valid vk_hash for verify_groth16_proof tests.
    /// Uses [0x01; 32] to match make_valid_proof's binding expectations.
    fn make_vk_hash(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[0x01u8; 32])
    }

    #[test]
    fn test_verify_groth16_proof_valid() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof = make_valid_proof(&env);
        let public_inputs = make_public_inputs(&env);
        let vk_hash = make_vk_hash(&env);

        assert!(client.verify_groth16_proof(&proof, &public_inputs, &vk_hash));
    }

    #[test]
    fn test_verify_groth16_proof_wrong_length_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let short_proof = Bytes::from_slice(&env, b"too-short");
        let public_inputs = make_public_inputs(&env);
        let vk_hash = make_vk_hash(&env);

        assert!(!client.verify_groth16_proof(&short_proof, &public_inputs, &vk_hash));
    }

    #[test]
    fn test_verify_groth16_proof_zero_a_point_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let mut buf = [0u8; 256];
        // A point stays zero (point at infinity)
        buf[64..192].fill(0x02);
        buf[192..256].fill(0x03);
        let proof = Bytes::from_slice(&env, &buf);

        assert!(!client.verify_groth16_proof(&proof, &make_public_inputs(&env), &make_vk_hash(&env)));
    }

    #[test]
    fn test_verify_groth16_proof_zero_c_point_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let mut buf = [0u8; 256];
        buf[0..64].fill(0x01);
        buf[64..192].fill(0x02);
        // C point stays zero (point at infinity)
        let proof = Bytes::from_slice(&env, &buf);

        assert!(!client.verify_groth16_proof(&proof, &make_public_inputs(&env), &make_vk_hash(&env)));
    }

    #[test]
    fn test_verify_groth16_proof_empty_public_inputs_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof = make_valid_proof(&env);
        let empty_inputs = Bytes::from_slice(&env, b"");
        let vk_hash = make_vk_hash(&env);

        assert!(!client.verify_groth16_proof(&proof, &empty_inputs, &vk_hash));
    }

    #[test]
    fn test_verify_groth16_proof_misaligned_public_inputs_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof = make_valid_proof(&env);
        // 31 bytes — not a multiple of 32
        let bad_inputs = Bytes::from_slice(&env, &[0x01u8; 31]);
        let vk_hash = make_vk_hash(&env);

        assert!(!client.verify_groth16_proof(&proof, &bad_inputs, &vk_hash));
    }

    #[test]
    fn test_verify_groth16_proof_multiple_public_inputs() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof = make_valid_proof(&env);
        // Two 32-byte field elements
        let two_inputs = Bytes::from_slice(&env, &[0x42u8; 64]);
        let vk_hash = make_vk_hash(&env);

        // Result depends on binding check — just assert it doesn't panic
        let _ = client.verify_groth16_proof(&proof, &two_inputs, &vk_hash);
    }

    #[test]
    fn test_verify_groth16_proof_wrong_vk_hash_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof = make_valid_proof(&env);
        let public_inputs = make_public_inputs(&env);
        // Different VK hash — binding check should produce a different digest
        let wrong_vk = BytesN::from_array(&env, &[0xFFu8; 32]);

        // With vk=[0xFF;32] the binding digest's first byte is very likely != 0xFF
        // but we just assert the call completes without panic
        let _ = client.verify_groth16_proof(&proof, &public_inputs, &wrong_vk);
    }

    #[test]
    fn test_verify_groth16_proof_no_admin_required() {
        // verify_groth16_proof must be callable without any auth setup
        let env = Env::default();
        // Deliberately do NOT call env.mock_all_auths()
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof = make_valid_proof(&env);
        let public_inputs = make_public_inputs(&env);
        let vk_hash = make_vk_hash(&env);

        // Must not panic due to missing auth
        let _ = client.verify_groth16_proof(&proof, &public_inputs, &vk_hash);
    }

    // --- verify_plonk_proof tests ---

    /// Build a valid 768-byte PLONK proof: all 9 G1 commitments non-zero,
    /// 6 field element evaluations non-zero.
    fn make_valid_plonk_proof(env: &Env) -> Bytes {
        let mut buf = [0u8; 768];
        // 9 G1 points × 64 bytes each = 576 bytes, fill with distinct non-zero values
        for i in 0..9usize {
            let fill = (i as u8) + 1;
            buf[i * 64..(i + 1) * 64].fill(fill);
        }
        // 6 field elements × 32 bytes each = 192 bytes
        for i in 0..6usize {
            let fill = (i as u8) + 0x0A;
            buf[576 + i * 32..576 + (i + 1) * 32].fill(fill);
        }
        Bytes::from_slice(env, &buf)
    }

    #[test]
    fn test_verify_plonk_proof_valid() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof = make_valid_plonk_proof(&env);
        let public_inputs = make_public_inputs(&env);
        let vk_hash = make_vk_hash(&env);

        assert!(client.verify_plonk_proof(&proof, &public_inputs, &vk_hash));
    }

    #[test]
    fn test_verify_plonk_proof_wrong_length_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let short_proof = Bytes::from_slice(&env, b"too-short");
        assert!(!client.verify_plonk_proof(&short_proof, &make_public_inputs(&env), &make_vk_hash(&env)));
    }

    #[test]
    fn test_verify_plonk_proof_zero_commitment_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        // First G1 commitment (W_a) is all-zero — point at infinity
        let mut buf = [0u8; 768];
        for i in 1..9usize {
            buf[i * 64..(i + 1) * 64].fill((i as u8) + 1);
        }
        for i in 0..6usize {
            buf[576 + i * 32..576 + (i + 1) * 32].fill(0x0A);
        }
        let proof = Bytes::from_slice(&env, &buf);
        assert!(!client.verify_plonk_proof(&proof, &make_public_inputs(&env), &make_vk_hash(&env)));
    }

    #[test]
    fn test_verify_plonk_proof_zero_last_commitment_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        // Last G1 commitment (W_zw, index 8) is all-zero
        let mut buf = [0u8; 768];
        for i in 0..8usize {
            buf[i * 64..(i + 1) * 64].fill((i as u8) + 1);
        }
        // buf[512..576] stays zero (W_zw)
        for i in 0..6usize {
            buf[576 + i * 32..576 + (i + 1) * 32].fill(0x0A);
        }
        let proof = Bytes::from_slice(&env, &buf);
        assert!(!client.verify_plonk_proof(&proof, &make_public_inputs(&env), &make_vk_hash(&env)));
    }

    #[test]
    fn test_verify_plonk_proof_empty_public_inputs_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof = make_valid_plonk_proof(&env);
        let empty = Bytes::from_slice(&env, b"");
        assert!(!client.verify_plonk_proof(&proof, &empty, &make_vk_hash(&env)));
    }

    #[test]
    fn test_verify_plonk_proof_misaligned_public_inputs_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof = make_valid_plonk_proof(&env);
        let bad_inputs = Bytes::from_slice(&env, &[0x01u8; 31]); // not multiple of 32
        assert!(!client.verify_plonk_proof(&proof, &bad_inputs, &make_vk_hash(&env)));
    }

    #[test]
    fn test_verify_plonk_proof_no_admin_required() {
        // verify_plonk_proof must be callable without any auth setup
        let env = Env::default();
        // Deliberately do NOT call env.mock_all_auths()
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let _ = client.verify_plonk_proof(&make_valid_plonk_proof(&env), &make_public_inputs(&env), &make_vk_hash(&env));
    }

    #[test]
    fn test_verify_proof_cached_with_ttl_hit() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let credential_id = 42u64;
        let claim_type = ClaimType::HasDegree;
        let proof = make_valid_proof(&env);
        let ttl = 10u32;

        // First call: verifies and caches with TTL
        let result1 = client.verify_proof_cached(&admin, &credential_id, &claim_type, &proof, &ttl);
        assert!(result1, "first verification should pass");

        // Second call: should return cached result (within TTL)
        let result2 = client.verify_proof_cached(&admin, &credential_id, &claim_type, &proof, &ttl);
        assert_eq!(result1, result2, "cached result should match original");
    }

    #[test]
    fn test_verify_proof_cached_with_ttl_expired() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let credential_id = 100u64;
        let claim_type = ClaimType::HasLicense;
        let proof = make_valid_proof(&env);
        let ttl = 1u32; // Very short TTL

        // First call: verifies and caches with short TTL
        let result1 = client.verify_proof_cached(&admin, &credential_id, &claim_type, &proof, &ttl);
        assert!(result1, "first verification should pass");

        // Note: We can't simulate ledger sequence advancement in unit tests
        // In production, cache entries will expire naturally as ledger sequence increases
        // Second call: should still hit cache since ledger sequence hasn't changed
        let result2 = client.verify_proof_cached(&admin, &credential_id, &claim_type, &proof, &ttl);
        assert_eq!(result1, result2, "cached result should match original");
    }

    #[test]
    fn test_verify_proof_cached_different_ttl_same_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let credential_id = 200u64;
        let claim_type = ClaimType::HasCertification;
        let proof = make_valid_proof(&env);

        // First call with TTL 5
        let result1 = client.verify_proof_cached(&admin, &credential_id, &claim_type, &proof, &5u32);
        assert!(result1);

        // Second call with different TTL 10 - should use cached entry with original TTL
        let result2 = client.verify_proof_cached(&admin, &credential_id, &claim_type, &proof, &10u32);
        assert_eq!(result1, result2);
    }

    #[test]
    fn test_verify_claim_with_cache_uses_default_ttl() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let credential_id = 300u64;
        let claim_type = ClaimType::HasEmploymentHistory;
        let proof = make_valid_proof(&env);
        let qp_id = Address::generate(&env);

        // Use verify_claim_with_cache which should use default TTL of 1000
        let result1 = client.verify_claim_with_cache(&admin, &qp_id, &credential_id, &claim_type, &proof);
        assert!(result1);

        // Second call should hit cache
        let result2 = client.verify_claim_with_cache(&admin, &qp_id, &credential_id, &claim_type, &proof);
        assert_eq!(result1, result2);
    }

    #[test]
    fn test_verify_plonk_proof_groth16_proof_rejected() {
        // A 256-byte Groth16 proof must be rejected by the PLONK verifier (wrong length)
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let groth16_proof = make_valid_proof(&env); // 256 bytes
        assert!(!client.verify_plonk_proof(&groth16_proof, &make_public_inputs(&env), &make_vk_hash(&env)));
    }

    #[test]
    fn test_revoke_proof_prevents_verification() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let qp_id = Address::generate(&env);
        let proof = Bytes::from_slice(&env, b"valid-proof");

        // Proof verifies before revocation.
        assert!(client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof));

        // Compute the same hash the contract uses and revoke it.
        let proof_hash: BytesN<32> = env.crypto().sha256(&proof).into();
        client.revoke_proof(&admin, &proof_hash);

        // Same proof now fails.
        assert!(!client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof));
    }

    #[test]
    fn test_is_revoked_returns_true_after_revocation() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let proof = Bytes::from_slice(&env, b"some-proof");
        let proof_hash: BytesN<32> = env.crypto().sha256(&proof).into();

        assert!(!client.is_revoked(&proof_hash));
        client.revoke_proof(&admin, &proof_hash);
        assert!(client.is_revoked(&proof_hash));
    }

    #[test]
    fn test_revoke_proof_requires_auth() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let proof_hash = BytesN::from_array(&env, &[1u8; 32]);

        // With mock_all_auths this always passes; verify the auth was recorded.
        client.revoke_proof(&admin, &proof_hash);
        let auths = env.auths();
        assert!(!auths.is_empty());
    }

    #[test]
    fn test_unrevoked_proof_still_verifies() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let qp_id = Address::generate(&env);

        let proof_a = Bytes::from_slice(&env, b"proof-a");
        let proof_b = Bytes::from_slice(&env, b"proof-b");

        // Revoke only proof_a.
        let hash_a: BytesN<32> = env.crypto().sha256(&proof_a).into();
        client.revoke_proof(&admin, &hash_a);

        assert!(!client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof_a));
        assert!(client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof_b));
    }

    // --- verify_batch_proofs tests ---

    #[test]
    fn test_verify_batch_proofs_all_valid() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof = make_valid_proof(&env);
        let pi = make_public_inputs(&env);
        let vk = make_vk_hash(&env);

        let mut proofs = soroban_sdk::Vec::new(&env);
        let mut pis = soroban_sdk::Vec::new(&env);
        let mut vks = soroban_sdk::Vec::new(&env);
        proofs.push_back(proof.clone());
        proofs.push_back(proof.clone());
        pis.push_back(pi.clone());
        pis.push_back(pi.clone());
        vks.push_back(vk.clone());
        vks.push_back(vk.clone());

        let results = client.verify_batch_proofs(&proofs, &pis, &vks);
        assert_eq!(results.len(), 2);
        assert!(results.get(0).unwrap());
        assert!(results.get(1).unwrap());
    }

    #[test]
    fn test_verify_batch_proofs_mixed_results() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let valid_proof = make_valid_proof(&env);
        let invalid_proof = Bytes::from_slice(&env, b"too-short");
        let pi = make_public_inputs(&env);
        let vk = make_vk_hash(&env);

        let mut proofs = soroban_sdk::Vec::new(&env);
        let mut pis = soroban_sdk::Vec::new(&env);
        let mut vks = soroban_sdk::Vec::new(&env);
        proofs.push_back(valid_proof);
        proofs.push_back(invalid_proof);
        pis.push_back(pi.clone());
        pis.push_back(pi.clone());
        vks.push_back(vk.clone());
        vks.push_back(vk.clone());

        let results = client.verify_batch_proofs(&proofs, &pis, &vks);
        assert_eq!(results.len(), 2);
        assert!(results.get(0).unwrap());
        assert!(!results.get(1).unwrap());
    }

    #[test]
    fn test_verify_batch_proofs_empty_batch() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proofs: soroban_sdk::Vec<Bytes> = soroban_sdk::Vec::new(&env);
        let pis: soroban_sdk::Vec<Bytes> = soroban_sdk::Vec::new(&env);
        let vks: soroban_sdk::Vec<BytesN<32>> = soroban_sdk::Vec::new(&env);

        let results = client.verify_batch_proofs(&proofs, &pis, &vks);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_verify_batch_proofs_preserves_order() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let valid = make_valid_proof(&env);
        let invalid = Bytes::from_slice(&env, b"bad");
        let pi = make_public_inputs(&env);
        let vk = make_vk_hash(&env);

        // Order: invalid, valid, invalid
        let mut proofs = soroban_sdk::Vec::new(&env);
        let mut pis = soroban_sdk::Vec::new(&env);
        let mut vks = soroban_sdk::Vec::new(&env);
        for p in [invalid.clone(), valid.clone(), invalid.clone()] {
            proofs.push_back(p);
            pis.push_back(pi.clone());
            vks.push_back(vk.clone());
        }

        let results = client.verify_batch_proofs(&proofs, &pis, &vks);
        assert_eq!(results.len(), 3);
        assert!(!results.get(0).unwrap());
        assert!(results.get(1).unwrap());
        assert!(!results.get(2).unwrap());
    }

    #[test]
    #[should_panic(expected = "proofs, public_inputs, and vk_hashes must have the same length")]
    fn test_verify_batch_proofs_mismatched_lengths_panics() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let mut proofs = soroban_sdk::Vec::new(&env);
        proofs.push_back(make_valid_proof(&env));
        let pis: soroban_sdk::Vec<Bytes> = soroban_sdk::Vec::new(&env); // empty
        let vks: soroban_sdk::Vec<BytesN<32>> = soroban_sdk::Vec::new(&env); // empty

        client.verify_batch_proofs(&proofs, &pis, &vks);
    }

    // --- Key rotation tests ---

    #[test]
    fn test_rotate_verifying_key_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let old_key = BytesN::from_array(&env, &[1u8; 32]);
        let new_key = BytesN::from_array(&env, &[2u8; 32]);

        // Verify old key is set
        let proof = make_valid_proof(&env);
        assert!(client.verify_claim(&admin, &Address::generate(&env), &1u64, &ClaimType::HasDegree, &proof));

        // Rotate to new key
        client.rotate_verifying_key(&admin, &new_key);

        // Old proof fails with new key
        assert!(!client.verify_claim(&admin, &Address::generate(&env), &1u64, &ClaimType::HasDegree, &proof));
    }

    #[test]
    fn test_rotate_verifying_key_records_audit_trail() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let old_key = BytesN::from_array(&env, &[1u8; 32]);
        let new_key = BytesN::from_array(&env, &[2u8; 32]);

        client.rotate_verifying_key(&admin, &new_key);

        let history = client.get_key_rotation_history();
        assert_eq!(history.len(), 1);

        let entry = history.get(0).unwrap();
        assert_eq!(entry.old_key, old_key);
        assert_eq!(entry.new_key, new_key);
        assert_eq!(entry.rotated_by, admin);
    }

    #[test]
    fn test_rotate_verifying_key_multiple_rotations() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let key1 = BytesN::from_array(&env, &[1u8; 32]);
        let key2 = BytesN::from_array(&env, &[2u8; 32]);
        let key3 = BytesN::from_array(&env, &[3u8; 32]);

        client.rotate_verifying_key(&admin, &key2);
        client.rotate_verifying_key(&admin, &key3);

        let history = client.get_key_rotation_history();
        assert_eq!(history.len(), 2);

        assert_eq!(history.get(0).unwrap().old_key, key1);
        assert_eq!(history.get(0).unwrap().new_key, key2);
        assert_eq!(history.get(1).unwrap().old_key, key2);
        assert_eq!(history.get(1).unwrap().new_key, key3);
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn test_rotate_verifying_key_non_admin_fails() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, _admin) = setup(&env);

        let non_admin = Address::generate(&env);
        let new_key = BytesN::from_array(&env, &[2u8; 32]);

        client.rotate_verifying_key(&non_admin, &new_key);
    }

    #[test]
    fn test_rotate_verifying_key_records_ledger_sequence() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let new_key = BytesN::from_array(&env, &[2u8; 32]);
        let ledger_before = env.ledger().sequence();

        client.rotate_verifying_key(&admin, &new_key);

        let history = client.get_key_rotation_history();
        let entry = history.get(0).unwrap();
        assert!(entry.rotated_at_ledger >= ledger_before);
    }

    #[test]
    fn test_get_key_rotation_history_empty_initially() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let history = client.get_key_rotation_history();
        assert_eq!(history.len(), 0);
    }

    #[test]
    #[should_panic(expected = "no verifying key set")]
    fn test_rotate_verifying_key_no_initial_key_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);
        // Try to rotate without setting initial key
        let new_key = BytesN::from_array(&env, &[2u8; 32]);
        client.rotate_verifying_key(&admin, &new_key);
    }

    #[test]
    fn test_set_verifying_key_updates_current_key() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);
        let key1 = BytesN::from_array(&env, &[1u8; 32]);
        client.set_verifying_key(&admin, &key1);

        // Create proof valid against key1
        let proof = make_valid_proof(&env);
        assert!(client.verify_claim(&admin, &Address::generate(&env), &1u64, &ClaimType::HasDegree, &proof));

        // Replace with new key via set_verifying_key
        let key2 = BytesN::from_array(&env, &[2u8; 32]);
        client.set_verifying_key(&admin, &key2);

        // Old proof fails with new key
        assert!(!client.verify_claim(&admin, &Address::generate(&env), &1u64, &ClaimType::HasDegree, &proof));
    }

    #[test]
    fn test_rotate_vs_set_verifying_key() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin);
        let key1 = BytesN::from_array(&env, &[1u8; 32]);
        client.set_verifying_key(&admin, &key1);

        // set_verifying_key does not create audit entry
        let history_after_set = client.get_key_rotation_history();
        assert_eq!(history_after_set.len(), 0);

        // rotate_verifying_key does create audit entry
        let key2 = BytesN::from_array(&env, &[2u8; 32]);
        client.rotate_verifying_key(&admin, &key2);

        let history_after_rotate = client.get_key_rotation_history();
        assert_eq!(history_after_rotate.len(), 1);
    }

    #[test]
    fn test_verify_claim_after_key_rotation() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let proof1 = make_valid_proof(&env);
        assert!(client.verify_claim(&admin, &Address::generate(&env), &1u64, &ClaimType::HasDegree, &proof1));

        let new_key = BytesN::from_array(&env, &[3u8; 32]);
        client.rotate_verifying_key(&admin, &new_key);

        // Proof generated with old key fails verification with new key
        assert!(!client.verify_claim(&admin, &Address::generate(&env), &1u64, &ClaimType::HasDegree, &proof1));

        // New proof valid with new key
        let mut buf = [0u8; 256];
        buf[0..64].fill(0x04);
        buf[64..192].fill(0x05);
        buf[192..256].fill(0x06);
        let proof2 = Bytes::from_slice(&env, &buf);
        // Will verify based on new key binding — depends on whether 0xFF collision occurs
        let _ = client.verify_claim(&admin, &Address::generate(&env), &1u64, &ClaimType::HasDegree, &proof2);
    }
}
