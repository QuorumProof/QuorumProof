use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Bytes, Vec};

/// Represents a fractional ownership share of a credential
#[contracttype]
#[derive(Clone)]
pub struct CredentialFraction {
    /// Unique fraction identifier
    pub id: u64,
    /// Original credential ID
    pub credential_id: u64,
    /// Fraction numerator (e.g., 1 in 1/4)
    pub numerator: u32,
    /// Fraction denominator (e.g., 4 in 1/4)
    pub denominator: u32,
    /// Current owner of this fraction
    pub owner: Address,
    /// Original issuer of the credential
    pub issuer: Address,
    /// Timestamp when fraction was created
    pub created_at: u64,
    /// Whether this fraction is transferable
    pub transferable: bool,
}

/// Represents fractional ownership state
#[contracttype]
#[derive(Clone)]
pub struct FractionalOwnershipState {
    /// Credential ID
    pub credential_id: u64,
    /// Total fractions created for this credential
    pub total_fractions: u32,
    /// Map of owner addresses to their fraction counts
    pub owner_fractions: soroban_sdk::Map<Address, u32>,
    /// Total denominator (maximum fractions possible)
    pub total_denominator: u32,
    /// Whether fractional transfer is enabled
    pub enabled: bool,
}

/// Represents a fraction transfer operation
#[contracttype]
#[derive(Clone)]
pub struct FractionTransfer {
    /// Unique transfer ID
    pub id: u64,
    /// Fraction ID being transferred
    pub fraction_id: u64,
    /// From address
    pub from: Address,
    /// To address
    pub to: Address,
    /// Fraction numerator
    pub numerator: u32,
    /// Fraction denominator
    pub denominator: u32,
    /// Timestamp of transfer
    pub transferred_at: u64,
    /// Transfer amount (in basis points)
    pub amount_bps: u32,
}

/// Fractional ownership configuration
#[contracttype]
#[derive(Clone)]
pub struct FractionalConfig {
    /// Minimum denominator allowed (minimum fraction size)
    pub min_denominator: u32,
    /// Maximum denominator allowed (maximum fraction size)
    pub max_denominator: u32,
    /// Minimum numerator for a valid fraction
    pub min_numerator: u32,
    /// Whether fractions require issuer approval to transfer
    pub require_issuer_approval: bool,
    /// Whether fractions require recipient approval
    pub require_recipient_approval: bool,
}

/// Event emitted when credential is fractionalized
#[contracttype]
#[derive(Clone)]
pub struct CredentialFractionalizedEventData {
    pub credential_id: u64,
    pub fractions_created: u32,
    pub denominator: u32,
    pub created_at: u64,
}

/// Event emitted when fraction is transferred
#[contracttype]
#[derive(Clone)]
pub struct FractionTransferredEventData {
    pub transfer_id: u64,
    pub fraction_id: u64,
    pub from: Address,
    pub to: Address,
    pub numerator: u32,
    pub denominator: u32,
    pub transferred_at: u64,
}

/// Error types for fractional transfer operations
#[contracterror]
#[repr(u32)]
pub enum FractionalError {
    FractionalTransferNotEnabled = 1,
    InvalidFraction = 2,
    InsufficientBalance = 3,
    InvalidDenominator = 4,
    FractionNotTransferable = 5,
    InvalidNumerator = 6,
    CredentialNotFractionalized = 7,
}
