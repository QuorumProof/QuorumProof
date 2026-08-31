/**
 * Mirror of `ContractError` enum in contracts/quorum_proof/src/lib.rs (#1445).
 */
export enum ContractError {
  CredentialNotFound = 1,
  SliceNotFound = 2,
  ContractPaused = 3,
  DuplicateCredential = 4,
  DuplicateAttestor = 5,
  AttestationExpired = 6,
  InvalidInput = 7,
  InvalidAddress = 8,
  OnboardingNotFound = 9,
  DisputeNotFound = 10,
  UnauthorizedAction = 11,
  InvalidApprovalWorkflow = 12,
  AlreadyChallenged = 13,
  ChallengeNotFound = 14,
  ChallengeResolved = 15,
  NotAttested = 16,
  NotInSlice = 17,
  AccusedCannotVote = 18,
  AlreadyVoted = 19,
  AttestationWindowOutside = 20,
  RecoveryNotFound = 21,
  RecoveryAlreadyExists = 22,
  RecoveryNotPending = 23,
  RecoveryAlreadyApproved = 24,
  RecoveryThresholdNotMet = 25,
  NotRecoveryApprover = 26,
  DuplicateRecoveryApproval = 27,
  InvalidParentType = 28,
  CircularHierarchy = 29,
  CredentialTypeNotFound = 30,
  HolderBlacklisted = 31,
  AlreadyBlacklisted = 32,
  NotBlacklisted = 33,
  ForkDetected = 34,
  ForkAlreadyResolved = 35,
  NoForkExists = 36,
  TransactionSizeExceeded = 37,
  InvalidTimestamp = 38,
  TransferNotAllowed = 39,
  UnauthorizedTransfer = 40,
  RateLimitExceeded = 41,
  NumericOverflow = 42,
  InvalidEnumValue = 43,
  PermissionDenied = 44,
  RevocationRequestNotFound = 45,
  RevocationNotPending = 46,
  CredentialVersionNotFound = 47,
  DecryptionKeyNotFound = 48,
  IssuancePolicyNotFound = 49,
  NotIssuanceSigner = 50,
  IssuanceRequestNotFound = 51,
  AlreadyApprovedIssuance = 52,
  IssuancePolicyRequired = 53,
  QuotaExceeded = 54,
  QuotaNotFound = 55,
  ProofRequestNotFound = 56,
  ProofRequestExpired = 57,
  InvalidStatusTransition = 58,
  NotRequestVerifier = 59,
  InvalidRevocationState = 60,
  RevocationTimeLockActive = 61,
  CircuitBreakerDegradedLimitReached = 62,
  AttestationPolicyNotFound = 63,
  NotAttestationSigner = 64,
  AlreadySignedAttestation = 65,
  AttestationRequestNotFound = 66,
  AttestationRequestExpired = 67,
  AttestationRequestFinalized = 68,
  InvalidSliceModification = 69,
  DelegationNotFound = 70,
  CannotDelegateToSelf = 71,
  InvalidThresholdConfig = 72,
  ThresholdExceedsTotalWeight = 73,
  MaxAttestorsExceeded = 74,
  InvalidCapacityLimit = 75,
  CredentialTypeAlreadyExists = 76,
  CredentialTypeVersionMismatch = 77,
  CredentialTypeVersionNotFound = 78,
  MigrationJobNotFound = 79,
  RoleNotFound = 80,
  RoleDelegationNotFound = 81,
  MaxDepthExceeded = 82,
  CycleDetected = 83,
  QuorumIntersectionFailed = 84,
  SnapshotNotFound = 85,
  SnapshotCorrupted = 86,
  InvalidEscrowConfig = 87,
  EscrowAlreadyExists = 88,
  EscrowNotFound = 89,
  EscrowAlreadyRecovered = 90,
  DuplicateShareSubmission = 91,
  InsufficientShares = 92,
  SchemaNotFound = 93,
}

/**
 * User-facing friendly messages mapped to numeric Soroban ContractError codes.
 */
export const CONTRACT_ERROR_MESSAGES: Record<ContractError, string> = {
  [ContractError.CredentialNotFound]: 'Requested credential was not found on chain.',
  [ContractError.SliceNotFound]: 'Quorum slice was not found on chain.',
  [ContractError.ContractPaused]: 'Contract is currently paused. Please try again later.',
  [ContractError.DuplicateCredential]: 'A credential with these details already exists.',
  [ContractError.DuplicateAttestor]: 'This credential has already been attested by this attestor.',
  [ContractError.AttestationExpired]: 'The attestation for this credential has expired.',
  [ContractError.InvalidInput]: 'Contract call was invalid. Please try again with correct data.',
  [ContractError.InvalidAddress]: 'Invalid Stellar address provided.',
  [ContractError.OnboardingNotFound]: 'Onboarding request not found.',
  [ContractError.DisputeNotFound]: 'Dispute not found.',
  [ContractError.UnauthorizedAction]: 'Action is not authorized. Please check your permissions.',
  [ContractError.InvalidApprovalWorkflow]: 'Invalid approval workflow state or sequence.',
  [ContractError.AlreadyChallenged]: 'A challenge is already active for this credential and attestor.',
  [ContractError.ChallengeNotFound]: 'Challenge not found.',
  [ContractError.ChallengeResolved]: 'Challenge has already been resolved.',
  [ContractError.NotAttested]: 'Credential is not attested or quorum threshold not met.',
  [ContractError.NotInSlice]: 'Address is not a member of the specified quorum slice.',
  [ContractError.AccusedCannotVote]: 'Accused party cannot vote on their own challenge.',
  [ContractError.AlreadyVoted]: 'Address has already voted on this challenge or dispute.',
  [ContractError.AttestationWindowOutside]: 'Attestation submitted outside the allowed time window.',
  [ContractError.RecoveryNotFound]: 'Recovery request not found.',
  [ContractError.RecoveryAlreadyExists]: 'A recovery request already exists for this credential.',
  [ContractError.RecoveryNotPending]: 'Recovery request is not in a pending state.',
  [ContractError.RecoveryAlreadyApproved]: 'Recovery request has already been approved by this address.',
  [ContractError.RecoveryThresholdNotMet]: 'Recovery threshold has not been met.',
  [ContractError.NotRecoveryApprover]: 'Caller is not an authorized recovery approver.',
  [ContractError.DuplicateRecoveryApproval]: 'Duplicate recovery approval submitted.',
  [ContractError.InvalidParentType]: 'Parent credential type not found.',
  [ContractError.CircularHierarchy]: 'Circular dependency detected in credential type hierarchy.',
  [ContractError.CredentialTypeNotFound]: 'Credential type is not registered.',
  [ContractError.HolderBlacklisted]: 'Credential holder is blacklisted by this issuer.',
  [ContractError.AlreadyBlacklisted]: 'Holder is already on the blacklist.',
  [ContractError.NotBlacklisted]: 'Holder is not on the blacklist.',
  [ContractError.ForkDetected]: 'Conflicting attestations detected for the same quorum slice.',
  [ContractError.ForkAlreadyResolved]: 'Fork has already been resolved for this slice.',
  [ContractError.NoForkExists]: 'No fork exists for this slice.',
  [ContractError.TransactionSizeExceeded]: 'Transaction payload size exceeds the maximum allowed limit.',
  [ContractError.InvalidTimestamp]: 'Invalid timestamp provided.',
  [ContractError.TransferNotAllowed]: 'Credential transfer is not allowed.',
  [ContractError.UnauthorizedTransfer]: 'Transfer not authorized by the credential subject.',
  [ContractError.RateLimitExceeded]: 'Rate limit exceeded. Please try again later.',
  [ContractError.NumericOverflow]: 'Numeric overflow detected.',
  [ContractError.InvalidEnumValue]: 'Invalid enum value provided.',
  [ContractError.PermissionDenied]: 'Permission denied for this operation.',
  [ContractError.RevocationRequestNotFound]: 'Revocation request not found.',
  [ContractError.RevocationNotPending]: 'Revocation request is not in a pending state.',
  [ContractError.CredentialVersionNotFound]: 'Credential version not found.',
  [ContractError.DecryptionKeyNotFound]: 'Decryption key entry not found for this party.',
  [ContractError.IssuancePolicyNotFound]: 'Issuance multisig policy not found for this credential type.',
  [ContractError.NotIssuanceSigner]: 'Caller is not a signer in the issuance multisig policy.',
  [ContractError.IssuanceRequestNotFound]: 'Issuance request not found.',
  [ContractError.AlreadyApprovedIssuance]: 'Caller has already approved this issuance request.',
  [ContractError.IssuancePolicyRequired]: 'Issuance policy is required for this credential type.',
  [ContractError.QuotaExceeded]: 'Credential issuance quota exceeded for this issuer.',
  [ContractError.QuotaNotFound]: 'No quota configured for this issuer.',
  [ContractError.ProofRequestNotFound]: 'Managed proof request not found.',
  [ContractError.ProofRequestExpired]: 'Proof request has expired.',
  [ContractError.InvalidStatusTransition]: 'Invalid status transition requested.',
  [ContractError.NotRequestVerifier]: 'Only the verifier that owns this request may update it.',
  [ContractError.InvalidRevocationState]: 'Invalid revocation state transition.',
  [ContractError.RevocationTimeLockActive]: 'Revocation time lock is still active.',
  [ContractError.CircuitBreakerDegradedLimitReached]: 'Circuit breaker write limit reached for degraded state.',
  [ContractError.AttestationPolicyNotFound]: 'Attestation policy not found for this credential type.',
  [ContractError.NotAttestationSigner]: 'Caller is not an authorized attestation signer.',
  [ContractError.AlreadySignedAttestation]: 'Attestation request has already been signed by this address.',
  [ContractError.AttestationRequestNotFound]: 'Attestation request not found.',
  [ContractError.AttestationRequestExpired]: 'Attestation request window has expired.',
  [ContractError.AttestationRequestFinalized]: 'Attestation request has already been finalized.',
  [ContractError.InvalidSliceModification]: 'Invalid quorum slice modification.',
  [ContractError.DelegationNotFound]: 'Role or attestor delegation not found.',
  [ContractError.CannotDelegateToSelf]: 'Cannot delegate permissions to yourself.',
  [ContractError.InvalidThresholdConfig]: 'Invalid quorum slice threshold configuration.',
  [ContractError.ThresholdExceedsTotalWeight]: 'Quorum threshold exceeds the total weight of slice members.',
  [ContractError.MaxAttestorsExceeded]: 'Exceeded maximum number of attestors per slice.',
  [ContractError.InvalidCapacityLimit]: 'Invalid slice capacity limit.',
  [ContractError.CredentialTypeAlreadyExists]: 'Credential type is already registered.',
  [ContractError.CredentialTypeVersionMismatch]: 'Credential type version mismatch during migration.',
  [ContractError.CredentialTypeVersionNotFound]: 'Credential type version not found in history.',
  [ContractError.MigrationJobNotFound]: 'Migration job not found.',
  [ContractError.RoleNotFound]: 'RBAC role not found for the given address.',
  [ContractError.RoleDelegationNotFound]: 'RBAC role delegation not found for the given address.',
  [ContractError.MaxDepthExceeded]: 'Maximum quorum slice nesting depth exceeded.',
  [ContractError.CycleDetected]: 'Cycle detected in nested quorum slice references.',
  [ContractError.QuorumIntersectionFailed]: 'Quorum intersection check failed or partition detected.',
  [ContractError.SnapshotNotFound]: 'Snapshot not found.',
  [ContractError.SnapshotCorrupted]: 'Snapshot integrity hash mismatch or corrupted data.',
  [ContractError.InvalidEscrowConfig]: 'Invalid key escrow guardian or threshold configuration.',
  [ContractError.EscrowAlreadyExists]: 'A key escrow already exists for this issuer.',
  [ContractError.EscrowNotFound]: 'Key escrow not found for this issuer.',
  [ContractError.EscrowAlreadyRecovered]: 'Key escrow has already been recovered.',
  [ContractError.DuplicateShareSubmission]: 'Guardian has already submitted a recovery share.',
  [ContractError.InsufficientShares]: 'Insufficient guardian shares submitted to meet the threshold.',
  [ContractError.SchemaNotFound]: 'Referenced slice schema version is not registered.',
};

/**
 * Substring fallback map for non-contract (network/RPC/client) errors.
 */
const SUBSTRING_FALLBACK_MAP: Record<string, string> = {
  'already attested': 'This credential has already been attested by your quorum slice.',
  'credential revoked': 'This credential has been revoked and cannot be used.',
  'not found': 'Requested credential was not found on chain.',
  'unauthorized': 'Action is not authorized. Please check your permissions.',
  'invalid request': 'Contract call was invalid. Please try again with correct data.',
};

/**
 * Extracts a Soroban contract error code from an error message string if present.
 * Matches patterns like Error(Contract, #11), Error(Contract, 11), etc.
 */
export function parseContractErrorCode(message: string): number | null {
  const match = message.match(/Error\(Contract,\s*#?(\d+)\)/i);
  if (match) {
    const code = parseInt(match[1], 10);
    if (!isNaN(code)) return code;
  }
  return null;
}

/**
 * Translate contract and simulation errors into user-facing friendly text (#1445).
 */
export function handleContractError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');

  if (!message || message === 'undefined' || message === 'null') {
    return 'An unknown contract error occurred.';
  }

  // 1. Check for numeric Soroban Error(Contract, #N)
  const code = parseContractErrorCode(message);
  if (code !== null) {
    const friendlyMessage = CONTRACT_ERROR_MESSAGES[code as ContractError];
    if (friendlyMessage) {
      return friendlyMessage;
    }
    return `Contract error #${code}: ${message}`;
  }

  // 2. Substring fallback for non-contract errors
  const normalized = message.toLowerCase();
  for (const [key, userMessage] of Object.entries(SUBSTRING_FALLBACK_MAP)) {
    if (normalized.includes(key)) {
      return userMessage;
    }
  }

  // 3. Generic fallback
  return `Contract error: ${message}`;
}
