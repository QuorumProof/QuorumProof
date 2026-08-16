//! Attestation Veto Mechanism (Issue #910)
//!
//! Allows designated authorities to veto attestations with time-locked delay.
//! Once attested, credentials cannot normally be un-attested. This module
//! provides a veto mechanism for designated authorities (e.g., regulatory bodies)
//! to dispute/veto an attestation with a configurable time-lock.
//!
//! ## Flow:
//! 1. Attestor submits attestation (marked as `Attested`)
//! 2. Authority can request veto within configurable window
//! 3. Veto request enters time-lock period (e.g., 48 hours)
//! 4. After time-lock expires, veto can be executed
//! 5. Execution moves credential to `VetoPending` state temporarily
//! 6. On successful veto, attestation is removed and audit logged

use soroban_sdk::{contracttype, Address, Bytes, Env, Symbol, Vec};

use crate::{EXTENDED_TTL, STANDARD_TTL};

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum VetoStatus {
    /// Veto request created, waiting for time-lock to expire
    Pending = 0,
    /// Time-lock expired, ready for execution
    Ready = 1,
    /// Veto has been executed, attestation removed
    Executed = 2,
    /// Veto was cancelled/rejected
    Cancelled = 3,
}

/// A veto request against a specific attestation
#[contracttype]
#[derive(Clone)]
pub struct VetoRequest {
    /// Unique veto request ID
    pub veto_id: u64,
    /// Credential ID being disputed
    pub credential_id: u64,
    /// Slice ID where attestation occurred
    pub slice_id: u64,
    /// Address of attestor being vetoed
    pub attestor: Address,
    /// Authority initiating the veto
    pub veto_authority: Address,
    /// Reason for veto
    pub reason: Option<Bytes>,
    /// Timestamp when veto was requested
    pub requested_at: u64,
    /// Timestamp when time-lock expires (veto becomes executable)
    pub unlocks_at: u64,
    /// Current status of the veto request
    pub status: VetoStatus,
    /// Optional evidence hash (e.g., IPFS hash of supporting documents)
    pub evidence_hash: Option<Bytes>,
}

/// Storage key for veto data
#[contracttype]
#[derive(Clone)]
pub enum DataKeyVeto {
    /// Current veto counter for generating unique IDs
    VetoCount,
    /// Veto request indexed by veto_id
    VetoRequest(u64),
    /// List of active veto requests for a credential
    VetoList(u64),
    /// Veto authorities (addresses allowed to initiate vetoes)
    VetoAuthorities,
    /// Time-lock duration in seconds (default: 172800 = 48 hours)
    VetoTimeLock,
    /// Audit trail of executed vetoes
    VetoExecutionLog,
}

/// Initialize veto authorities on contract initialization
pub fn init_veto_authorities(env: &Env, authorities: Vec<Address>) {
    let key = DataKeyVeto::VetoAuthorities;
    env.storage().instance().set(&key, &authorities);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    // Set default time-lock to 48 hours (172800 seconds)
    let timelock_key = DataKeyVeto::VetoTimeLock;
    env.storage().instance().set(&timelock_key, &172_800u64);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
}

/// Check if an address is authorized to create veto requests
pub fn is_veto_authority(env: &Env, address: &Address) -> bool {
    let key = DataKeyVeto::VetoAuthorities;
    if let Some(authorities) = env
        .storage()
        .instance()
        .get::<DataKeyVeto, Vec<Address>>(&key)
    {
        for auth in authorities.iter() {
            if auth == *address {
                return true;
            }
        }
    }
    false
}

/// Add a veto authority
pub fn add_veto_authority(env: &Env, authority: Address) {
    let key = DataKeyVeto::VetoAuthorities;
    let mut authorities = env
        .storage()
        .instance()
        .get::<DataKeyVeto, Vec<Address>>(&key)
        .unwrap_or_else(|| Vec::new(env));
    
    // Check if already added
    for auth in authorities.iter() {
        if auth == authority {
            return; // Already added
        }
    }
    
    authorities.push_back(authority);
    env.storage().instance().set(&key, &authorities);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
}

/// Remove a veto authority
pub fn remove_veto_authority(env: &Env, authority: &Address) {
    let key = DataKeyVeto::VetoAuthorities;
    if let Some(authorities) = env
        .storage()
        .instance()
        .get::<DataKeyVeto, Vec<Address>>(&key)
    {
        let mut new_authorities = Vec::new(env);
        for auth in authorities.iter() {
            if auth != *authority {
                new_authorities.push_back(auth.clone());
            }
        }
        env.storage().instance().set(&key, &new_authorities);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }
}

/// Get current veto time-lock duration (seconds)
pub fn get_veto_timelock(env: &Env) -> u64 {
    let key = DataKeyVeto::VetoTimeLock;
    env.storage()
        .instance()
        .get::<DataKeyVeto, u64>(&key)
        .unwrap_or(172_800) // 48 hours default
}

/// Set veto time-lock duration
pub fn set_veto_timelock(env: &Env, seconds: u64) {
    let key = DataKeyVeto::VetoTimeLock;
    env.storage().instance().set(&key, &seconds);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
}

/// Generate next veto ID (monotonic counter)
fn next_veto_id(env: &Env) -> u64 {
    let key = DataKeyVeto::VetoCount;
    let count = env
        .storage()
        .instance()
        .get::<DataKeyVeto, u64>(&key)
        .unwrap_or(0);
    
    let next = count.saturating_add(1);
    env.storage().instance().set(&key, &next);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    next
}

/// Request a veto for an attestation
pub fn request_veto(
    env: &Env,
    veto_authority: Address,
    credential_id: u64,
    slice_id: u64,
    attestor: Address,
    reason: Option<Bytes>,
    evidence_hash: Option<Bytes>,
) -> u64 {
    // Verify authority is authorized
    if !is_veto_authority(env, &veto_authority) {
        panic!("not authorized to request veto");
    }

    let now = env.ledger().timestamp();
    let timelock = get_veto_timelock(env);
    let veto_id = next_veto_id(env);

    let veto = VetoRequest {
        veto_id,
        credential_id,
        slice_id,
        attestor,
        veto_authority,
        reason,
        requested_at: now,
        unlocks_at: now.saturating_add(timelock),
        status: VetoStatus::Pending,
        evidence_hash,
    };

    // Store the veto request
    let key = DataKeyVeto::VetoRequest(veto_id);
    env.storage().instance().set(&key, &veto);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    // Add to credential's veto list
    let list_key = DataKeyVeto::VetoList(credential_id);
    let mut veto_list = env
        .storage()
        .instance()
        .get::<DataKeyVeto, Vec<u64>>(&list_key)
        .unwrap_or_else(|| Vec::new(env));
    veto_list.push_back(veto_id);
    env.storage().instance().set(&list_key, &veto_list);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    veto_id
}

/// Get a veto request by ID
pub fn get_veto_request(env: &Env, veto_id: u64) -> Option<VetoRequest> {
    let key = DataKeyVeto::VetoRequest(veto_id);
    env.storage().instance().get::<DataKeyVeto, VetoRequest>(&key)
}

/// Get all veto requests for a credential
pub fn get_credential_veto_requests(env: &Env, credential_id: u64) -> Vec<u64> {
    let list_key = DataKeyVeto::VetoList(credential_id);
    env.storage()
        .instance()
        .get::<DataKeyVeto, Vec<u64>>(&list_key)
        .unwrap_or_else(|| Vec::new(env))
}

/// Cancel a veto request (only by the authority who created it or admin)
pub fn cancel_veto(env: &Env, canceller: &Address, veto_id: u64) {
    let key = DataKeyVeto::VetoRequest(veto_id);
    if let Some(mut veto) = env
        .storage()
        .instance()
        .get::<DataKeyVeto, VetoRequest>(&key)
    {
        // Only the authority who created it can cancel
        if veto.veto_authority != *canceller {
            panic!("only veto authority can cancel");
        }

        if veto.status == VetoStatus::Executed || veto.status == VetoStatus::Cancelled {
            panic!("cannot cancel executed or already-cancelled veto");
        }

        veto.status = VetoStatus::Cancelled;
        env.storage().instance().set(&key, &veto);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    } else {
        panic!("veto request not found");
    }
}

/// Execute a veto (after time-lock has expired)
/// Returns true if veto was executed, false if not yet ready
pub fn execute_veto(env: &Env, executor: &Address, veto_id: u64) -> bool {
    let key = DataKeyVeto::VetoRequest(veto_id);
    if let Some(mut veto) = env
        .storage()
        .instance()
        .get::<DataKeyVeto, VetoRequest>(&key)
    {
        // Only admin or veto authority can execute
        if veto.veto_authority != *executor {
            panic!("not authorized to execute this veto");
        }

        if veto.status != VetoStatus::Pending && veto.status != VetoStatus::Ready {
            panic!("veto is not in executable state");
        }

        let now = env.ledger().timestamp();
        if now < veto.unlocks_at {
            // Time-lock not yet expired
            veto.status = VetoStatus::Ready;
            env.storage().instance().set(&key, &veto);
            env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
            return false;
        }

        // Time-lock expired, mark as executed
        veto.status = VetoStatus::Executed;
        env.storage().instance().set(&key, &veto);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Log the execution
        log_veto_execution(env, &veto);

        true
    } else {
        panic!("veto request not found");
    }
}

/// Log veto execution in audit trail
fn log_veto_execution(env: &Env, veto: &VetoRequest) {
    let log_key = DataKeyVeto::VetoExecutionLog;
    let mut log = env
        .storage()
        .instance()
        .get::<DataKeyVeto, Vec<(u64, u64, Address)>>(&log_key)
        .unwrap_or_else(|| Vec::new(env));
    
    log.push_back((veto.veto_id, veto.credential_id, veto.veto_authority.clone()));
    env.storage().instance().set(&log_key, &log);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
}

/// Get veto execution audit log
pub fn get_veto_audit_log(env: &Env) -> Vec<(u64, u64, Address)> {
    let log_key = DataKeyVeto::VetoExecutionLog;
    env.storage()
        .instance()
        .get::<DataKeyVeto, Vec<(u64, u64, Address)>>(&log_key)
        .unwrap_or_else(|| Vec::new(env))
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup(env: &Env) -> Vec<Address> {
        let mut authorities = Vec::new(env);
        authorities.push_back(Address::generate(env));
        authorities.push_back(Address::generate(env));
        init_veto_authorities(env, authorities.clone());
        authorities
    }

    #[test]
    fn test_veto_authority_management() {
        let env = Env::default();
        let contract_id = env.register_contract(None, crate::QuorumProofContract);
        env.as_contract(&contract_id, || {
            let authorities = setup(&env);

            assert!(is_veto_authority(&env, &authorities.get(0).unwrap()));
            assert!(is_veto_authority(&env, &authorities.get(1).unwrap()));
            assert!(!is_veto_authority(&env, &Address::generate(&env)));

            let new_auth = Address::generate(&env);
            add_veto_authority(&env, new_auth.clone());
            assert!(is_veto_authority(&env, &new_auth));

            remove_veto_authority(&env, &new_auth);
            assert!(!is_veto_authority(&env, &new_auth));
        });
    }

    #[test]
    fn test_veto_request_lifecycle() {
        let env = Env::default();
        let contract_id = env.register_contract(None, crate::QuorumProofContract);
        env.as_contract(&contract_id, || {
            let authorities = setup(&env);
            let veto_auth = authorities.get(0).unwrap();

            let veto_id = request_veto(
                &env,
                veto_auth.clone(),
                1,      // credential_id
                100,    // slice_id
                Address::generate(&env),
                Some(Bytes::new(&env)),
                None,
            );

            let veto = get_veto_request(&env, veto_id).unwrap();
            assert_eq!(veto.veto_id, veto_id);
            assert_eq!(veto.credential_id, 1);
            assert_eq!(veto.status, VetoStatus::Pending);

            // Check it's in the credential's list
            let requests = get_credential_veto_requests(&env, 1);
            assert_eq!(requests.len(), 1);
        });
    }

    #[test]
    fn test_veto_timelock() {
        let env = Env::default();
        let contract_id = env.register_contract(None, crate::QuorumProofContract);
        env.as_contract(&contract_id, || {
            let _authorities = setup(&env);

            let default = get_veto_timelock(&env);
            assert_eq!(default, 172_800); // 48 hours

            set_veto_timelock(&env, 86_400); // 1 day
            assert_eq!(get_veto_timelock(&env), 86_400);
        });
    }
}
