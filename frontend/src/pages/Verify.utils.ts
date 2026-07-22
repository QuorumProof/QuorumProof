import type { Credential } from '../lib/contracts/quorumProof';

export const DEFAULT_SLICE_ID = 1n;

const CREDENTIAL_TYPES: Record<number, string> = {
  1: '🎓 Degree', 2: '🏛️ License', 3: '💼 Employment',
  4: '📜 Certification', 5: '🔬 Research',
};

export function credTypeLabel(n: number | bigint): string {
  return CREDENTIAL_TYPES[Number(n)] || `Type ${n}`;
}

export function formatTimestamp(ts: number | bigint | null | undefined): string {
  if (!ts) return 'Never';
  return new Date(Number(ts) * 1000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

export function formatAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr || '—';
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

export function buildShareUrl(id: bigint): string {
  return `${window.location.origin}/verify?id=${id}`;
}

export function parseIdFromUrl(url: string): bigint | null {
  try {
    const u = new URL(url);
    const raw = u.searchParams.get('id');
    if (!raw) return null;
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 1) return null;
    return BigInt(n);
  } catch {
    return null;
  }
}

export type StatusClass = 'valid' | 'revoked' | 'expired' | 'pending' | 'warning';

export interface StatusInfo {
  statusClass: StatusClass;
  statusIcon: string;
  statusTitle: string;
  statusSub: string;
}

export function deriveStatus(
  revoked: boolean,
  expired: boolean,
  attested: boolean | null,
  attestorCount: number,
  expiresAt?: bigint | null,
): StatusInfo {
  if (revoked) return { statusClass: 'revoked', statusIcon: '🚫', statusTitle: 'Credential Revoked', statusSub: 'This credential has been officially revoked.' };
  if (expired) return { statusClass: 'expired', statusIcon: '⏰', statusTitle: 'Credential Expired', statusSub: `This credential expired on ${formatTimestamp(expiresAt)}.` };
  if (attested === true || attestorCount > 0) return { statusClass: 'valid', statusIcon: '✅', statusTitle: 'Credential Verified', statusSub: `Attested by ${attestorCount} trusted node${attestorCount !== 1 ? 's' : ''}.` };
  if (attested === null) return { statusClass: 'warning', statusIcon: '⚠️', statusTitle: 'Attestation Status Unconfirmed', statusSub: 'Could not confirm quorum attestation. The credential may still be valid.' };
  return { statusClass: 'pending', statusIcon: '⏳', statusTitle: 'Awaiting Attestation', statusSub: 'No attestors have signed this credential yet.' };
}

export interface VerifyResult {
  credential: Credential;
  attestors: string[];
  expired: boolean;
  attested: boolean | null;
}
