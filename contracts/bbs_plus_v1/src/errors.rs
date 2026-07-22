
use core::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BbsError {
    InvalidMessageCount,
    InvalidProofStructure,
    InvalidSignature,
    InvalidPresentation,
    TranscriptError,
    SerializationError,
    DeserializationError,
    InvalidG1Point,
    InvalidG2Point,
    InvalidScalar,
    VerificationFailed,
    InvalidAccumulator,
    InvalidNonMembershipProof,
    PredicateVerificationFailed,
    InvalidChallenge,
    NonceMismatch,
    RevocationCheckFailed,
    CurveArithmeticError,
    ProofCompositionError,
}

impl fmt::Display for BbsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BbsError::InvalidMessageCount => write!(f, "Invalid message count"),
            BbsError::InvalidProofStructure => write!(f, "Invalid proof structure"),
            BbsError::InvalidSignature => write!(f, "Invalid signature"),
            BbsError::InvalidPresentation => write!(f, "Invalid presentation"),
            BbsError::TranscriptError => write!(f, "Transcript error"),
            BbsError::SerializationError => write!(f, "Serialization error"),
            BbsError::DeserializationError => write!(f, "Deserialization error"),
            BbsError::InvalidG1Point => write!(f, "Invalid G1 point"),
            BbsError::InvalidG2Point => write!(f, "Invalid G2 point"),
            BbsError::InvalidScalar => write!(f, "Invalid scalar"),
            BbsError::VerificationFailed => write!(f, "Verification failed"),
            BbsError::InvalidAccumulator => write!(f, "Invalid accumulator"),
            BbsError::InvalidNonMembershipProof => write!(f, "Invalid non-membership proof"),
            BbsError::PredicateVerificationFailed => write!(f, "Predicate verification failed"),
            BbsError::InvalidChallenge => write!(f, "Invalid challenge"),
            BbsError::NonceMismatch => write!(f, "Nonce mismatch"),
            BbsError::RevocationCheckFailed => write!(f, "Revocation check failed"),
            BbsError::CurveArithmeticError => write!(f, "Curve arithmetic error"),
            BbsError::ProofCompositionError => write!(f, "Proof composition error"),
        }
    }
}

pub type BbsResult<T> = Result<T, BbsError>;
