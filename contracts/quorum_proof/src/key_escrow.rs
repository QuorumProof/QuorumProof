//! BBS+ issuer key escrow/backup (#1295).
//!
//! The actual Shamir splitting/reconstruction math (`bbs_plus_v1::escrow`)
//! runs off-chain: an issuer with no on-chain entropy source splits their
//! BBS+ signing key into `threshold`-of-`guardians.len()` shares themselves,
//! then deposits one opaque share per guardian here. This module only
//! tracks *who holds which share* and *whether enough guardians have
//! consented to a recovery* -- it never sees the underlying secret, only
//! the 32-byte share blobs guardians will later feed back into
//! `bbs_plus_v1::escrow::reconstruct_secret` off-chain.
use crate::{ContractError, DataKeyEscrow, EXTENDED_TTL, STANDARD_TTL};
use soroban_sdk::{contracttype, panic_with_error, Address, BytesN, Env, String, Vec};

#[contracttype]
#[derive(Clone)]
pub struct GuardianShare {
    pub guardian: Address,
    pub share_index: u32,
    pub encrypted_share: BytesN<32>,
}

#[contracttype]
#[derive(Clone)]
pub struct KeyEscrow {
    pub issuer: Address,
    pub threshold: u32,
    pub total_shares: u32,
    pub guardians: Vec<Address>,
    pub created_at: u64,
    pub recovered: bool,
}

fn find_guardian(guardians: &Vec<Address>, guardian: &Address) -> bool {
    for i in 0..guardians.len() {
        if guardians.get(i).unwrap() == *guardian {
            return true;
        }
    }
    false
}

/// Deposits a threshold key escrow for `issuer`. Issuer-only: the caller
/// must already be authenticated and role-checked as `Role::Issuer` by the
/// contract entry point before this is invoked.
pub fn deposit_key_escrow(
    env: &Env,
    issuer: &Address,
    guardians: Vec<Address>,
    shares: Vec<BytesN<32>>,
    threshold: u32,
) -> KeyEscrow {
    if guardians.len() != shares.len() {
        panic_with_error!(env, ContractError::InvalidEscrowConfig);
    }
    let total_shares = guardians.len();
    if threshold < 2 || threshold > total_shares {
        panic_with_error!(env, ContractError::InvalidEscrowConfig);
    }
    if env
        .storage()
        .instance()
        .has(&DataKeyEscrow::Escrow(issuer.clone()))
    {
        panic_with_error!(env, ContractError::EscrowAlreadyExists);
    }

    let now = env.ledger().timestamp();
    for i in 0..guardians.len() {
        let guardian = guardians.get(i).unwrap();
        let share = shares.get(i).unwrap();
        env.storage().instance().set(
            &DataKeyEscrow::GuardianShare(issuer.clone(), guardian.clone()),
            &GuardianShare {
                guardian: guardian.clone(),
                share_index: i + 1,
                encrypted_share: share,
            },
        );
    }

    let escrow = KeyEscrow {
        issuer: issuer.clone(),
        threshold,
        total_shares,
        guardians: guardians.clone(),
        created_at: now,
        recovered: false,
    };
    env.storage()
        .instance()
        .set(&DataKeyEscrow::Escrow(issuer.clone()), &escrow);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let topic = String::from_str(env, crate::TOPIC_KEY_ESCROW_DEPOSITED);
    let mut topics: Vec<soroban_sdk::String> = Vec::new(env);
    topics.push_back(topic);
    env.events().publish(
        topics,
        (crate::TOPIC_KEY_ESCROW_DEPOSITED, issuer.clone(), total_shares),
    );

    escrow
}

/// A guardian confirms participation in a recovery for `issuer`'s escrow.
/// Returns the number of guardians who have submitted so far.
pub fn submit_recovery_share(env: &Env, guardian: &Address, issuer: &Address) -> u32 {
    let escrow: KeyEscrow = env
        .storage()
        .instance()
        .get(&DataKeyEscrow::Escrow(issuer.clone()))
        .unwrap_or_else(|| panic_with_error!(env, ContractError::EscrowNotFound));

    if escrow.recovered {
        panic_with_error!(env, ContractError::EscrowAlreadyRecovered);
    }
    if !find_guardian(&escrow.guardians, guardian) {
        panic_with_error!(env, ContractError::PermissionDenied);
    }

    let mut submissions: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKeyEscrow::RecoverySubmissions(issuer.clone()))
        .unwrap_or(Vec::new(env));

    if find_guardian(&submissions, guardian) {
        panic_with_error!(env, ContractError::DuplicateShareSubmission);
    }

    submissions.push_back(guardian.clone());
    let count = submissions.len();
    env.storage()
        .instance()
        .set(&DataKeyEscrow::RecoverySubmissions(issuer.clone()), &submissions);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    count
}

/// Once `threshold` guardians have submitted, the issuer (or contract
/// admin) retrieves the stored share blobs for off-chain reconstruction via
/// `bbs_plus_v1::escrow::reconstruct_secret`. Marks the escrow as recovered
/// so it cannot be replayed.
pub fn recover_key(env: &Env, caller: &Address, issuer: &Address) -> Vec<GuardianShare> {
    let mut escrow: KeyEscrow = env
        .storage()
        .instance()
        .get(&DataKeyEscrow::Escrow(issuer.clone()))
        .unwrap_or_else(|| panic_with_error!(env, ContractError::EscrowNotFound));

    if escrow.recovered {
        panic_with_error!(env, ContractError::EscrowAlreadyRecovered);
    }

    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&crate::DataKey::Admin)
        .expect("not initialized");
    if *caller != escrow.issuer && *caller != stored_admin {
        panic_with_error!(env, ContractError::PermissionDenied);
    }

    let submissions: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKeyEscrow::RecoverySubmissions(issuer.clone()))
        .unwrap_or(Vec::new(env));

    if submissions.len() < escrow.threshold {
        panic_with_error!(env, ContractError::InsufficientShares);
    }

    let mut shares: Vec<GuardianShare> = Vec::new(env);
    for i in 0..submissions.len() {
        let guardian = submissions.get(i).unwrap();
        if let Some(share) = env
            .storage()
            .instance()
            .get::<_, GuardianShare>(&DataKeyEscrow::GuardianShare(issuer.clone(), guardian.clone()))
        {
            shares.push_back(share);
        }
    }

    escrow.recovered = true;
    env.storage()
        .instance()
        .set(&DataKeyEscrow::Escrow(issuer.clone()), &escrow);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let topic = String::from_str(env, crate::TOPIC_KEY_ESCROW_RECOVERED);
    let mut topics: Vec<soroban_sdk::String> = Vec::new(env);
    topics.push_back(topic);
    env.events()
        .publish(topics, (crate::TOPIC_KEY_ESCROW_RECOVERED, issuer.clone()));

    shares
}

pub fn get_key_escrow(env: &Env, issuer: &Address) -> Option<KeyEscrow> {
    env.storage()
        .instance()
        .get(&DataKeyEscrow::Escrow(issuer.clone()))
}

/// Issuer-only: cancels an in-progress recovery for `issuer`'s escrow,
/// clearing any accumulated `submit_recovery_share` progress so guardians
/// must resubmit before a future `recover_key` can succeed.
pub fn cancel_key_recovery(env: &Env, issuer: &Address) {
    let escrow: KeyEscrow = env
        .storage()
        .instance()
        .get(&DataKeyEscrow::Escrow(issuer.clone()))
        .unwrap_or_else(|| panic_with_error!(env, ContractError::EscrowNotFound));

    if escrow.recovered {
        panic_with_error!(env, ContractError::EscrowAlreadyRecovered);
    }

    env.storage()
        .instance()
        .set(&DataKeyEscrow::RecoverySubmissions(issuer.clone()), &Vec::<Address>::new(env));
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let topic = String::from_str(env, crate::TOPIC_KEY_ESCROW_RECOVERY_CANCELLED);
    let mut topics: Vec<soroban_sdk::String> = Vec::new(env);
    topics.push_back(topic);
    env.events().publish(
        topics,
        (crate::TOPIC_KEY_ESCROW_RECOVERY_CANCELLED, issuer.clone()),
    );
}
