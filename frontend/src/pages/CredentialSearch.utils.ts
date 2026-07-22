import type { Credential } from '../lib/contracts/quorumProof';

export type CredentialStatus = 'all' | 'active' | 'revoked' | 'expired';

export interface SearchFilters {
  subject: string;
  issuer: string;
  credentialType: string;
  status: CredentialStatus;
  startDate: string;
  endDate: string;
}

export interface SearchResult {
  credential: Credential;
  attestors: string[];
  expired: boolean;
}

/** Apply client-side filters to results */
export function applyFilters(results: SearchResult[], filters: SearchFilters): SearchResult[] {
  return results.filter(({ credential, expired }) => {
    if (filters.issuer && !credential.issuer.toLowerCase().includes(filters.issuer.toLowerCase())) return false;
    if (filters.credentialType && credential.credential_type !== Number(filters.credentialType)) return false;
    if (filters.status === 'revoked' && !credential.revoked) return false;
    if (filters.status === 'active' && (credential.revoked || expired)) return false;
    if (filters.status === 'expired' && !expired) return false;
    if (filters.startDate) {
      const start = new Date(filters.startDate).getTime() / 1000;
      if (credential.expires_at && Number(credential.expires_at) < start) return false;
    }
    if (filters.endDate) {
      const end = new Date(filters.endDate).getTime() / 1000;
      if (credential.expires_at && Number(credential.expires_at) > end) return false;
    }
    return true;
  });
}
