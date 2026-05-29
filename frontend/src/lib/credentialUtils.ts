import type { Credential, QuorumSlice } from './contracts/quorumProof';
import type { SearchFilters } from '../components/CredentialSearchFilter';

export type AttestationStatus = 'attested' | 'pending' | 'revoked' | 'expired';

export interface CredCardData {
  credential: Credential;
  attested: boolean;
  slice: QuorumSlice | null;
  expired: boolean;
  sliceError: boolean;
  credError: string | null;
}

export const CREDENTIAL_TYPES: Record<number, string> = {
  1: '🎓 Degree',
  2: '🏛️ License',
  3: '💼 Employment',
  4: '📜 Certification',
  5: '🔬 Research',
};

export const ATTESTOR_ROLES = [
  'Lead Verifier',
  'Co-Verifier',
  'Auditor',
  'Reviewer',
  'Observer',
];

/** Derive attestation status with priority: revoked > expired > attested > pending */
export function deriveStatus(
  revoked: boolean,
  expired: boolean,
  attested: boolean
): AttestationStatus {
  if (revoked) return 'revoked';
  if (expired) return 'expired';
  if (attested) return 'attested';
  return 'pending';
}

/** Truncate a Stellar address to first 8 + last 6 chars */
export function formatAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr || '—';
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

/** Get role label for an attestor by index */
export function attestorRole(index: number): string {
  return ATTESTOR_ROLES[index] ?? `Member ${index + 1}`;
}

/** Get human-readable credential type label */
export function credTypeLabel(n: number | bigint): string {
  return CREDENTIAL_TYPES[Number(n)] || `Type ${n}`;
}

/** Format a Unix timestamp (seconds) to a readable date string */
export function formatTimestamp(
  ts: number | bigint | null | undefined
): string {
  if (!ts) return 'Never';
  return new Date(Number(ts) * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Apply search query, status filter, and sort to a list of CredCardData. */
export function filterAndSortCards(
  cards: CredCardData[],
  filters: SearchFilters
): CredCardData[] {
  const q = (filters.query ?? '').toLowerCase().trim();

  let result = cards.filter((card) => {
    const { credential, expired } = card;

    // Status filter
    if (filters.status !== 'all') {
      const status = deriveStatus(credential.revoked, expired, card.attested);
      if (filters.status === 'active' && status !== 'attested' && status !== 'pending') return false;
      if (filters.status === 'expired' && status !== 'expired') return false;
      if (filters.status === 'revoked' && status !== 'revoked') return false;
    }

    // Type filter
    if (filters.credentialType !== undefined && credential.credential_type !== filters.credentialType) {
      return false;
    }

    // Text search: type label, issuer, subject
    if (q) {
      const typeLabel = credTypeLabel(credential.credential_type).toLowerCase();
      if (
        !typeLabel.includes(q) &&
        !credential.issuer.toLowerCase().includes(q) &&
        !credential.subject.toLowerCase().includes(q)
      ) {
        return false;
      }
    }

    return true;
  });

  // Sort
  result = [...result].sort((a, b) => {
    let cmp = 0;
    const { sortField, sortOrder } = filters;
    if (sortField === 'issuer') {
      cmp = a.credential.issuer.localeCompare(b.credential.issuer);
    } else if (sortField === 'expiry') {
      const aExp = Number(a.credential.expires_at ?? 0);
      const bExp = Number(b.credential.expires_at ?? 0);
      cmp = aExp - bExp;
    } else {
      // 'issued' — use credential id as proxy (higher id = issued later)
      cmp = Number(a.credential.id) - Number(b.credential.id);
    }
    return sortOrder === 'asc' ? cmp : -cmp;
  });

  return result;
}
