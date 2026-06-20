import type { ClaimType, ProofRequest } from './contracts/zkVerifier';

export interface ClaimTypeOption {
  value: ClaimType;
  label: string;
  icon: string;
  /** What the verifier learns when this claim is proven. */
  discloses: string;
  /** What stays hidden even though it lives on the same credential. */
  hides: string[];
}

export const CLAIM_TYPE_OPTIONS: ClaimTypeOption[] = [
  {
    value: 'HasDegree',
    label: 'Degree',
    icon: '🎓',
    discloses: 'You hold a verified degree credential.',
    hides: ['Institution name', 'Field of study', 'Graduation date', 'Grades or honors'],
  },
  {
    value: 'HasLicense',
    label: 'License category',
    icon: '🏛️',
    discloses: 'You hold a verified professional license.',
    hides: ['Licensing body', 'License number', 'Issue date', 'Jurisdiction'],
  },
  {
    value: 'HasEmploymentHistory',
    label: 'Employer',
    icon: '💼',
    discloses: 'You hold a verified employment credential.',
    hides: ['Employer name', 'Job title', 'Salary', 'Employment dates'],
  },
  {
    value: 'HasCertification',
    label: 'Certification',
    icon: '📜',
    discloses: 'You hold a verified certification.',
    hides: ['Certifying body', 'Certification name', 'Score or grade'],
  },
  {
    value: 'HasResearchPublication',
    label: 'Research publication',
    icon: '🔬',
    discloses: 'You hold a verified research publication credential.',
    hides: ['Publication title', 'Co-authors', 'Venue', 'Publication date'],
  },
];

export function findClaimTypeOption(value: ClaimType): ClaimTypeOption {
  return CLAIM_TYPE_OPTIONS.find((o) => o.value === value) ?? CLAIM_TYPE_OPTIONS[0];
}

/** Encode a proof request as a JSON string suitable for sharing/clipboard. */
export function encodeProofRequest(request: ProofRequest): string {
  return JSON.stringify({
    credential_id: request.credential_id.toString(),
    claim_type: request.claim_type,
    nonce: request.nonce.toString(),
  });
}

/** Build a verifier-facing URL that pre-fills the claim type for a credential. */
export function buildProofShareUrl(request: ProofRequest): string {
  const params = new URLSearchParams({
    id: request.credential_id.toString(),
    claimType: request.claim_type,
    nonce: request.nonce.toString(),
  });
  return `${window.location.origin}/verify?${params.toString()}`;
}
