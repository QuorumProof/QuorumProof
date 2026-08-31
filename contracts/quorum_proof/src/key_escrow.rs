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
//!
//! ## Guardian rotation (#1392)
//!
//! An escrow is deposited once per issuer; a lost or compromised guardian key,
//! or a change to the guardian set, is handled by
//! `rotate_key_escrow_guardians`. Rotation is issuer-only and follows the same
//! off-chain flow as the initial deposit: the issuer re-splits the *same* BBS+
//! signing key into a fresh `new_threshold`-of-`new_guardians.len()` set with
//! `bbs_plus_v1::escrow`, then submits the new share blobs here. The old
//! guardians' share entries are deleted, so shares from before a rotation can
//! no longer be combined through this contract.
//!
//! Rotation is only allowed while `recovered == false` — once a key has been
//! recovered the escrow is spent and the issuer must deposit a new one against
//! a new key. Any partial recovery progress (guardians who already called
//! `submit_recovery_share`) is **reset** by a rotation, since those
//! submissions refer to shares that no longer exist. That also means rotation
//! is the issuer's escape hatch if a rogue guardian starts a recovery.
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

/// Replaces the guardian set, share blobs and threshold of an existing
/// escrow. Issuer-only: the caller must already be authenticated and
/// role-checked by the contract entry point before this is invoked. Any
/// in-progress recovery submissions are cleared, because they refer to shares
/// that this rotation removes.
pub fn rotate_key_escrow_guardians(
    env: &Env,
    issuer: &Address,
    new_guardians: Vec<Address>,
    new_shares: Vec<BytesN<32>>,
    new_threshold: u32,
) -> KeyEscrow {
    let escrow: KeyEscrow = env
        .storage()
        .instance()
        .get(&DataKeyEscrow::Escrow(issuer.clone()))
        .unwrap_or_else(|| panic_with_error!(env, ContractError::EscrowNotFound));

    if escrow.recovered {
        panic_with_error!(env, ContractError::EscrowAlreadyRecovered);
    }
    if new_guardians.len() != new_shares.len() {
        panic_with_error!(env, ContractError::InvalidEscrowConfig);
    }
    let new_total_shares = new_guardians.len();
    if new_threshold < 2 || new_threshold > new_total_shares {
        panic_with_error!(env, ContractError::InvalidEscrowConfig);
    }

    let old_guardian_count = escrow.total_shares;

    // Drop the previous guardians' shares first: a guardian dropped by this
    // rotation must not keep a usable entry behind.
    for guardian in escrow.guardians.iter() {
        env.storage()
            .instance()
            .remove(&DataKeyEscrow::GuardianShare(issuer.clone(), guardian));
    }

    let mut share_index = 0u32;
    for (guardian, share) in new_guardians.iter().zip(new_shares.iter()) {
        share_index += 1;
        env.storage().instance().set(
            &DataKeyEscrow::GuardianShare(issuer.clone(), guardian.clone()),
            &GuardianShare {
                guardian,
                share_index,
                encrypted_share: share,
            },
        );
    }

    // Submissions collected against the old shares are meaningless now.
    env.storage()
        .instance()
        .remove(&DataKeyEscrow::RecoverySubmissions(issuer.clone()));

    let rotated = KeyEscrow {
        issuer: escrow.issuer,
        threshold: new_threshold,
        total_shares: new_total_shares,
        guardians: new_guardians,
        created_at: escrow.created_at,
        recovered: false,
    };
    env.storage()
        .instance()
        .set(&DataKeyEscrow::Escrow(issuer.clone()), &rotated);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let topic = String::from_str(env, crate::TOPIC_KEY_ESCROW_ROTATED);
    let mut topics: Vec<soroban_sdk::String> = Vec::new(env);
    topics.push_back(topic);
    env.events().publish(
        topics,
        (
            crate::TOPIC_KEY_ESCROW_ROTATED,
            issuer.clone(),
            old_guardian_count,
            new_total_shares,
        ),
    );

    rotated
}

pub fn get_key_escrow(env: &Env, issuer: &Address) -> Option<KeyEscrow> {
    env.storage()
        .instance()
        .get(&DataKeyEscrow::Escrow(issuer.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{QuorumProofContract, QuorumProofContractClient};
    use soroban_sdk::testutils::Address as _;

    const ROLE_ISSUER: u32 = 2;

    struct EscrowTest {
        env: Env,
        contract_id: Address,
        client_issuer: Address,
        guardians: Vec<Address>,
    }

    fn shares(env: &Env, count: u32) -> Vec<BytesN<32>> {
        let mut shares: Vec<BytesN<32>> = Vec::new(env);
        for i in 0..count {
            shares.push_back(BytesN::from_array(env, &[i as u8; 32]));
        }
        shares
    }

    fn setup() -> EscrowTest {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        client.assign_role(&admin, &issuer, &ROLE_ISSUER, &0u64);

        let mut guardians: Vec<Address> = Vec::new(&env);
        for _ in 0..3u32 {
            guardians.push_back(Address::generate(&env));
        }
        client.deposit_key_escrow(&issuer, &guardians, &shares(&env, 3), &2u32);

        EscrowTest {
            env,
            contract_id,
            client_issuer: issuer,
            guardians,
        }
    }

    #[test]
    fn rotation_replaces_guardian_set_and_threshold() {
        let test = setup();
        let client = QuorumProofContractClient::new(&test.env, &test.contract_id);

        let mut new_guardians: Vec<Address> = Vec::new(&test.env);
        new_guardians.push_back(test.guardians.get(0).unwrap());
        for _ in 0..3u32 {
            new_guardians.push_back(Address::generate(&test.env));
        }

        let rotated = client.rotate_key_escrow_guardians(
            &test.client_issuer,
            &new_guardians,
            &shares(&test.env, 4),
            &3u32,
        );

        assert_eq!(rotated.total_shares, 4);
        assert_eq!(rotated.threshold, 3);
        assert_eq!(rotated.guardians, new_guardians);
        assert!(!rotated.recovered);

        // A guardian dropped by the rotation keeps no usable share entry.
        let dropped = test.guardians.get(2).unwrap();
        test.env.as_contract(&test.contract_id, || {
            assert!(!test.env.storage().instance().has(
                &DataKeyEscrow::GuardianShare(test.client_issuer.clone(), dropped.clone())
            ));
        });
    }

    #[test]
    #[should_panic]
    fn rotation_by_non_issuer_is_rejected() {
        let test = setup();
        let client = QuorumProofContractClient::new(&test.env, &test.contract_id);
        let stranger = Address::generate(&test.env);

        client.rotate_key_escrow_guardians(
            &stranger,
            &test.guardians,
            &shares(&test.env, 3),
            &2u32,
        );
    }

    #[test]
    fn rotation_resets_partial_recovery_progress() {
        let test = setup();
        let client = QuorumProofContractClient::new(&test.env, &test.contract_id);

        let submitted =
            client.submit_recovery_share(&test.guardians.get(0).unwrap(), &test.client_issuer);
        assert_eq!(submitted, 1);

        let mut new_guardians: Vec<Address> = Vec::new(&test.env);
        for _ in 0..3u32 {
            new_guardians.push_back(Address::generate(&test.env));
        }
        client.rotate_key_escrow_guardians(
            &test.client_issuer,
            &new_guardians,
            &shares(&test.env, 3),
            &2u32,
        );

        test.env.as_contract(&test.contract_id, || {
            assert!(!test.env.storage().instance().has(
                &DataKeyEscrow::RecoverySubmissions(test.client_issuer.clone())
            ));
        });

        // The first new guardian starts a fresh recovery from zero.
        let after =
            client.submit_recovery_share(&new_guardians.get(0).unwrap(), &test.client_issuer);
        assert_eq!(after, 1);
    }

    #[test]
    #[should_panic]
    fn rotation_after_recovery_is_rejected() {
        let test = setup();
        let client = QuorumProofContractClient::new(&test.env, &test.contract_id);

        client.submit_recovery_share(&test.guardians.get(0).unwrap(), &test.client_issuer);
        client.submit_recovery_share(&test.guardians.get(1).unwrap(), &test.client_issuer);
        client.recover_key(&test.client_issuer, &test.client_issuer);

        client.rotate_key_escrow_guardians(
            &test.client_issuer,
            &test.guardians,
            &shares(&test.env, 3),
            &2u32,
        );
    }
}
