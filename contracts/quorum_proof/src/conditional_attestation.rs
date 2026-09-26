/// Conditional Attestation Module - Issue #1594
/// Implements if-then conditional logic for complex attestation scenarios
/// Enables conditional attestation trees where slices can require conditions on attestor participation

use soroban_sdk::{contracttype, Address, Bytes, Env, Vec};

/// Condition predicate type enum
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum ConditionPredicateType {
    /// Attestor must be present (simple existence check)
    AttestorPresent = 1,
    /// Attestor must have weight >= threshold
    WeightThreshold = 2,
    /// Attestor must have attestation value = true
    AttestationValueTrue = 3,
    /// Attestor must not be in suspension list
    NotSuspended = 4,
    /// Multiple conditions with AND logic
    AndCondition = 5,
    /// Multiple conditions with OR logic
    OrCondition = 6,
    /// Reputation score must exceed threshold
    ReputationThreshold = 7,
}

/// Single condition predicate that can be evaluated
#[contracttype]
#[derive(Clone)]
pub struct ConditionPredicate {
    /// The type of predicate
    pub predicate_type: ConditionPredicateType,
    /// The attestor this condition applies to (if applicable)
    pub target_attestor: Option<Address>,
    /// Numeric threshold (for weight, reputation, etc.)
    pub threshold_value: Option<u32>,
    /// Child condition IDs for AND/OR operations
    pub child_condition_ids: Vec<u64>,
}

/// Conditional attestation tree node
#[contracttype]
#[derive(Clone)]
pub struct ConditionalAttestationNode {
    /// Unique ID for this node
    pub id: u64,
    /// The condition that must be met
    pub condition: ConditionPredicate,
    /// The slice ID this condition belongs to
    pub slice_id: u64,
    /// If condition is met, reference the attestor weight
    pub then_weight: u32,
    /// If condition fails, fallback weight (0 = attestation fails)
    pub else_weight: u32,
    /// Whether this node is active
    pub active: bool,
    /// Created at timestamp
    pub created_at: u64,
}

/// Conditional attestation tree for complex validation scenarios
#[contracttype]
#[derive(Clone)]
pub struct ConditionalAttestationTree {
    /// Unique tree ID
    pub id: u64,
    /// Root condition ID
    pub root_condition_id: u64,
    /// Associated slice ID
    pub slice_id: u64,
    /// Number of conditions in tree
    pub condition_count: u32,
    /// Max depth of tree
    pub max_depth: u32,
    /// Whether tree is active
    pub active: bool,
    /// Created by
    pub created_by: Address,
    /// Created at timestamp
    pub created_at: u64,
}

/// Result of condition evaluation
#[contracttype]
#[derive(Clone)]
pub struct ConditionEvaluationResult {
    /// Whether the condition evaluated to true
    pub is_satisfied: bool,
    /// The effective weight if condition is satisfied
    pub effective_weight: u32,
    /// Addresses that participated in satisfying the condition
    pub participating_attestors: Vec<Address>,
    /// Timestamp of evaluation
    pub evaluated_at: u64,
}

/// Conditional attestation event data
#[contracttype]
#[derive(Clone)]
pub struct ConditionalAttestationEventData {
    pub credential_id: u64,
    pub slice_id: u64,
    pub condition_id: u64,
    pub is_satisfied: bool,
    pub effective_weight: u32,
}
