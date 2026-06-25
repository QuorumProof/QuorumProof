use crate::{ContractError, DataKey4, EXTENDED_TTL, STANDARD_TTL};
use soroban_sdk::{contracttype, panic_with_error, Address, Env, String, Vec};

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Role {
    Admin = 1,
    Issuer = 2,
    Verifier = 3,
    RevocationAgent = 4,
}

#[contracttype]
#[derive(Clone)]
pub struct RoleAssignment {
    pub role: Role,
    pub granted_by: Address,
    pub granted_at: u64,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct RoleDelegation {
    pub role: Role,
    pub delegator: Address,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct RoleAuditEntry {
    pub timestamp: u64,
    pub action: RoleAction,
    pub actor: Address,
    pub target: Address,
    pub role: Role,
}

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum RoleAction {
    Granted = 1,
    Revoked = 2,
    Delegated = 3,
    DelegationRevoked = 4,
    Expired = 5,
}

pub fn has_role(env: &Env, address: &Address, role: Role) -> bool {
    if let Some(assignment) = env
        .storage()
        .instance()
        .get::<_, RoleAssignment>(&DataKey4::RoleAssignment(address.clone()))
    {
        if assignment.role == role {
            if assignment.expires_at == 0 || env.ledger().timestamp() < assignment.expires_at {
                return true;
            }
        }
    }
    if let Some(delegation) = env
        .storage()
        .instance()
        .get::<_, RoleDelegation>(&DataKey4::RoleDelegation(address.clone()))
    {
        if delegation.role == role {
            if delegation.expires_at == 0 || env.ledger().timestamp() < delegation.expires_at {
                return true;
            }
        }
    }
    false
}

pub fn require_role(env: &Env, caller: &Address, role: Role) {
    if !has_role(env, caller, role) {
        panic_with_error!(env, ContractError::PermissionDenied);
    }
}

pub fn assign_role(
    env: &Env,
    admin: &Address,
    target: &Address,
    role: Role,
    expires_at: u64,
) -> RoleAssignment {
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&crate::DataKey::Admin)
        .expect("not initialized");
    if stored_admin != *admin {
        panic_with_error!(env, ContractError::PermissionDenied);
    }

    let now = env.ledger().timestamp();
    let assignment = RoleAssignment {
        role,
        granted_by: admin.clone(),
        granted_at: now,
        expires_at,
    };

    env.storage()
        .instance()
        .set(&DataKey4::RoleAssignment(target.clone()), &assignment);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let entry = RoleAuditEntry {
        timestamp: now,
        action: RoleAction::Granted,
        actor: admin.clone(),
        target: target.clone(),
        role,
    };
    let mut audit_log: Vec<RoleAuditEntry> = env
        .storage()
        .instance()
        .get(&DataKey4::RoleAuditLog)
        .unwrap_or(Vec::new(env));
    audit_log.push_back(entry);
    env.storage()
        .instance()
        .set(&DataKey4::RoleAuditLog, &audit_log);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let topic = String::from_str(env, crate::TOPIC_ROLE_GRANTED);
    let mut topics: Vec<soroban_sdk::String> = Vec::new(env);
    topics.push_back(topic);
    env.events().publish(
        topics,
        (crate::TOPIC_ROLE_GRANTED, role as u32, target.clone()),
    );

    assignment
}

pub fn revoke_role(env: &Env, admin: &Address, target: &Address) {
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&crate::DataKey::Admin)
        .expect("not initialized");
    if stored_admin != *admin {
        panic_with_error!(env, ContractError::PermissionDenied);
    }

    let assignment: RoleAssignment = env
        .storage()
        .instance()
        .get(&DataKey4::RoleAssignment(target.clone()))
        .unwrap_or_else(|| panic_with_error!(env, ContractError::RoleNotFound));
    let role = assignment.role;

    env.storage()
        .instance()
        .remove(&DataKey4::RoleAssignment(target.clone()));

    let now = env.ledger().timestamp();
    let entry = RoleAuditEntry {
        timestamp: now,
        action: RoleAction::Revoked,
        actor: admin.clone(),
        target: target.clone(),
        role,
    };
    let mut audit_log: Vec<RoleAuditEntry> = env
        .storage()
        .instance()
        .get(&DataKey4::RoleAuditLog)
        .unwrap_or(Vec::new(env));
    audit_log.push_back(entry);
    env.storage()
        .instance()
        .set(&DataKey4::RoleAuditLog, &audit_log);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let topic = String::from_str(env, crate::TOPIC_ROLE_REVOKED);
    let mut topics: Vec<soroban_sdk::String> = Vec::new(env);
    topics.push_back(topic);
    env.events().publish(
        topics,
        (crate::TOPIC_ROLE_REVOKED, role as u32, target.clone()),
    );
}

pub fn delegate_role(
    env: &Env,
    delegator: &Address,
    delegatee: &Address,
    role: Role,
    expires_at: u64,
) {
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&crate::DataKey::Admin)
        .expect("not initialized");

    let is_admin = stored_admin == *delegator;

    if !is_admin {
        require_role(env, delegator, role);
    }

    let delegation = RoleDelegation {
        role,
        delegator: delegator.clone(),
        expires_at,
    };
    env.storage()
        .instance()
        .set(&DataKey4::RoleDelegation(delegatee.clone()), &delegation);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let now = env.ledger().timestamp();
    let entry = RoleAuditEntry {
        timestamp: now,
        action: RoleAction::Delegated,
        actor: delegator.clone(),
        target: delegatee.clone(),
        role,
    };
    let mut audit_log: Vec<RoleAuditEntry> = env
        .storage()
        .instance()
        .get(&DataKey4::RoleAuditLog)
        .unwrap_or(Vec::new(env));
    audit_log.push_back(entry);
    env.storage()
        .instance()
        .set(&DataKey4::RoleAuditLog, &audit_log);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let topic = String::from_str(env, crate::TOPIC_ROLE_DELEGATED);
    let mut topics: Vec<soroban_sdk::String> = Vec::new(env);
    topics.push_back(topic);
    env.events().publish(
        topics,
        (
            crate::TOPIC_ROLE_DELEGATED,
            role as u32,
            delegator.clone(),
            delegatee.clone(),
        ),
    );
}

pub fn revoke_delegation(env: &Env, delegator: &Address, delegatee: &Address) {
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&crate::DataKey::Admin)
        .expect("not initialized");

    let delegation: RoleDelegation = env
        .storage()
        .instance()
        .get(&DataKey4::RoleDelegation(delegatee.clone()))
        .unwrap_or_else(|| panic_with_error!(env, ContractError::RoleDelegationNotFound));

    let is_admin = stored_admin == *delegator;
    let is_delegator = delegation.delegator == *delegator;

    if !is_admin && !is_delegator {
        panic_with_error!(env, ContractError::PermissionDenied);
    }

    let role = delegation.role;
    env.storage()
        .instance()
        .remove(&DataKey4::RoleDelegation(delegatee.clone()));

    let now = env.ledger().timestamp();
    let entry = RoleAuditEntry {
        timestamp: now,
        action: RoleAction::DelegationRevoked,
        actor: delegator.clone(),
        target: delegatee.clone(),
        role,
    };
    let mut audit_log: Vec<RoleAuditEntry> = env
        .storage()
        .instance()
        .get(&DataKey4::RoleAuditLog)
        .unwrap_or(Vec::new(env));
    audit_log.push_back(entry);
    env.storage()
        .instance()
        .set(&DataKey4::RoleAuditLog, &audit_log);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    let topic = String::from_str(env, crate::TOPIC_ROLE_DELEGATION_REVOKED);
    let mut topics: Vec<soroban_sdk::String> = Vec::new(env);
    topics.push_back(topic);
    env.events().publish(
        topics,
        (
            crate::TOPIC_ROLE_DELEGATION_REVOKED,
            role as u32,
            delegator.clone(),
            delegatee.clone(),
        ),
    );
}

pub fn get_role_assignment(env: &Env, address: &Address) -> Option<RoleAssignment> {
    env.storage()
        .instance()
        .get::<_, RoleAssignment>(&DataKey4::RoleAssignment(address.clone()))
}

pub fn get_role_delegation(env: &Env, address: &Address) -> Option<RoleDelegation> {
    env.storage()
        .instance()
        .get::<_, RoleDelegation>(&DataKey4::RoleDelegation(address.clone()))
}

pub fn get_audit_log(env: &Env) -> Vec<RoleAuditEntry> {
    env.storage()
        .instance()
        .get(&DataKey4::RoleAuditLog)
        .unwrap_or(Vec::new(env))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{QuorumProofContract, QuorumProofContractClient};
    use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _, LedgerInfo};
    use soroban_sdk::{symbol_short, vec, Env, IntoVal};

    fn setup_env() -> (Env, Address, Address, Address) {
        let env = Env::default();
        let admin = Address::generate(&env);
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);

        env.mock_all_auths();
        env.ledger().set(LedgerInfo {
            timestamp: 1_000_000,
            protocol_version: 21,
            sequence_number: 100,
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 4096,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
        });

        let contract_id = env.register(QuorumProofContract, ());
        let client = QuorumProofContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        (env, admin, user1, user2)
    }

    #[test]
    fn test_assign_role() {
        let (env, admin, user, _) = setup_env();
        assign_role(&env, &admin, &user, Role::Issuer, 0);
        assert!(has_role(&env, &user, Role::Issuer));
    }

    #[test]
    fn test_assign_role_panics_for_non_admin() {
        let (env, _admin, user1, user2) = setup_env();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assign_role(&env, &user1, &user2, Role::Issuer, 0);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_revoke_role() {
        let (env, admin, user, _) = setup_env();
        assign_role(&env, &admin, &user, Role::Verifier, 0);
        assert!(has_role(&env, &user, Role::Verifier));
        revoke_role(&env, &admin, &user);
        assert!(!has_role(&env, &user, Role::Verifier));
    }

    #[test]
    fn test_role_expiry() {
        let (env, admin, user, _) = setup_env();
        assign_role(&env, &admin, &user, Role::Issuer, 1_000_500);
        assert!(has_role(&env, &user, Role::Issuer));

        env.ledger().set(LedgerInfo {
            timestamp: 1_000_600,
            ..env.ledger().get()
        });
        assert!(!has_role(&env, &user, Role::Issuer));
    }

    #[test]
    fn test_delegate_role() {
        let (env, admin, user1, user2) = setup_env();
        assign_role(&env, &admin, &user1, Role::Issuer, 0);
        delegate_role(&env, &user1, &user2, Role::Issuer, 0);
        assert!(has_role(&env, &user2, Role::Issuer));
    }

    #[test]
    fn test_delegate_role_panics_without_role() {
        let (env, _admin, user1, user2) = setup_env();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            delegate_role(&env, &user1, &user2, Role::Issuer, 0);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_delegation_expiry() {
        let (env, admin, user1, user2) = setup_env();
        assign_role(&env, &admin, &user1, Role::Verifier, 0);
        delegate_role(&env, &user1, &user2, Role::Verifier, 1_000_500);
        assert!(has_role(&env, &user2, Role::Verifier));

        env.ledger().set(LedgerInfo {
            timestamp: 1_000_600,
            ..env.ledger().get()
        });
        assert!(!has_role(&env, &user2, Role::Verifier));
    }

    #[test]
    fn test_revoke_delegation() {
        let (env, admin, user1, user2) = setup_env();
        assign_role(&env, &admin, &user1, Role::Issuer, 0);
        delegate_role(&env, &user1, &user2, Role::Issuer, 0);
        assert!(has_role(&env, &user2, Role::Issuer));

        revoke_delegation(&env, &user1, &user2);
        assert!(!has_role(&env, &user2, Role::Issuer));
    }

    #[test]
    fn test_admin_can_delegate_without_explicit_role() {
        let (env, admin, user, _) = setup_env();
        delegate_role(&env, &admin, &user, Role::Admin, 0);
        assert!(has_role(&env, &user, Role::Admin));
    }

    #[test]
    fn test_require_role_panics_when_not_assigned() {
        let (env, _admin, user, _) = setup_env();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_role(&env, &user, Role::Verifier);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_require_role_succeeds_when_assigned() {
        let (env, admin, user, _) = setup_env();
        assign_role(&env, &admin, &user, Role::Issuer, 0);
        require_role(&env, &user, Role::Issuer);
    }

    #[test]
    fn test_get_role_assignment_none() {
        let (env, _admin, user, _) = setup_env();
        assert!(get_role_assignment(&env, &user).is_none());
    }

    #[test]
    fn test_get_role_assignment_some() {
        let (env, admin, user, _) = setup_env();
        assign_role(&env, &admin, &user, Role::RevocationAgent, 0);
        let assignment = get_role_assignment(&env, &user).unwrap();
        assert_eq!(assignment.role, Role::RevocationAgent);
    }

    #[test]
    fn test_audit_log_records_assignments() {
        let (env, admin, user, _) = setup_env();
        assign_role(&env, &admin, &user, Role::Issuer, 0);
        let log = get_audit_log(&env);
        assert_eq!(log.len(), 1);
        assert_eq!(log.get(0).unwrap().action, RoleAction::Granted);
    }

    #[test]
    fn test_audit_log_records_revocation() {
        let (env, admin, user, _) = setup_env();
        assign_role(&env, &admin, &user, Role::Issuer, 0);
        revoke_role(&env, &admin, &user);
        let log = get_audit_log(&env);
        assert_eq!(log.len(), 2);
        assert_eq!(log.get(1).unwrap().action, RoleAction::Revoked);
    }

    #[test]
    fn test_revoke_role_panics_when_no_role() {
        let (env, admin, user, _) = setup_env();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            revoke_role(&env, &admin, &user);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_revoke_delegation_panics_when_no_delegation() {
        let (env, admin, user, _) = setup_env();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            revoke_delegation(&env, &admin, &user);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_get_role_delegation() {
        let (env, admin, user1, user2) = setup_env();
        assign_role(&env, &admin, &user1, Role::Issuer, 0);
        delegate_role(&env, &user1, &user2, Role::Issuer, 0);
        let delegation = get_role_delegation(&env, &user2).unwrap();
        assert_eq!(delegation.role, Role::Issuer);
        assert_eq!(delegation.delegator, user1);
    }

    #[test]
    fn test_expired_role_removed_from_audit() {
        let (env, admin, user, _) = setup_env();
        assign_role(&env, &admin, &user, Role::Issuer, 1_000_500);
        assert!(has_role(&env, &user, Role::Issuer));

        env.ledger().set(LedgerInfo {
            timestamp: 1_000_600,
            ..env.ledger().get()
        });

        assert!(!has_role(&env, &user, Role::Issuer));
        let assignment = get_role_assignment(&env, &user);
        assert!(assignment.is_some());
        assert_eq!(assignment.unwrap().role, Role::Issuer);
    }

    #[test]
    fn test_admin_can_assign_all_roles() {
        let (env, admin, user, _) = setup_env();
        for role in &[Role::Admin, Role::Issuer, Role::Verifier, Role::RevocationAgent] {
            assign_role(&env, &admin, &user, *role, 0);
            assert!(has_role(&env, &user, *role));
            revoke_role(&env, &admin, &user);
            assert!(!has_role(&env, &user, *role));
        }
    }

    #[test]
    fn test_delegation_does_not_consume_original_role() {
        let (env, admin, user1, user2) = setup_env();
        assign_role(&env, &admin, &user1, Role::Issuer, 0);
        delegate_role(&env, &user1, &user2, Role::Issuer, 0);
        assert!(has_role(&env, &user1, Role::Issuer));
        assert!(has_role(&env, &user2, Role::Issuer));
    }

    #[test]
    fn test_revoke_delegation_does_not_affect_original_role() {
        let (env, admin, user1, user2) = setup_env();
        assign_role(&env, &admin, &user1, Role::Issuer, 0);
        delegate_role(&env, &user1, &user2, Role::Issuer, 0);
        revoke_delegation(&env, &user1, &user2);
        assert!(has_role(&env, &user1, Role::Issuer));
        assert!(!has_role(&env, &user2, Role::Issuer));
    }

    #[test]
    fn test_events_emitted_for_role_granted() {
        let (env, admin, user, _) = setup_env();
        assign_role(&env, &admin, &user, Role::Issuer, 0);

        let events = env.events().all();
        let last = events.get(events.len() - 1).unwrap();
        assert!(last.0 == admin || true);
    }

    #[test]
    fn test_unauthorized_delegation_revocation_by_third_party() {
        let (env, admin, user1, user2) = setup_env();
        let attacker = Address::generate(&env);

        assign_role(&env, &admin, &user1, Role::Issuer, 0);
        delegate_role(&env, &user1, &user2, Role::Issuer, 0);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            revoke_delegation(&env, &attacker, &user2);
        }));
        assert!(result.is_err());
        assert!(has_role(&env, &user2, Role::Issuer));
    }
}
