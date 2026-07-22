import type { Credential } from '../lib/contracts/quorumProof';
import { credTypeLabel, formatAddress, formatTimestamp } from '../lib/credentialUtils';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuditEventType = 'issued' | 'attested' | 'revoked' | 'expired';

export interface AuditEvent {
  type: AuditEventType;
  label: string;
  detail: string;
  icon: string;
  timestamp: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export const EVENT_CONFIG: Record<AuditEventType, { icon: string; colorClass: string }> = {
  issued:   { icon: '📄', colorClass: 'audit-dot--issued'   },
  attested: { icon: '✅', colorClass: 'audit-dot--attested' },
  revoked:  { icon: '🚫', colorClass: 'audit-dot--revoked'  },
  expired:  { icon: '⏰', colorClass: 'audit-dot--expired'  },
};

export function buildAuditEvents(
  credential: Credential,
  attestors: string[],
  expired: boolean,
): AuditEvent[] {
  const events: AuditEvent[] = [];

  // Issued — always first
  events.push({
    type: 'issued',
    label: 'Credential Issued',
    detail: `${credTypeLabel(credential.credential_type)} issued by ${formatAddress(credential.issuer)} to ${formatAddress(credential.subject)}`,
    icon: '📄',
    timestamp: 'Genesis',
  });

  // Attestations
  attestors.forEach((addr, idx) => {
    events.push({
      type: 'attested',
      label: `Attestation #${idx + 1}`,
      detail: `Attested by ${formatAddress(addr)}`,
      icon: '✅',
      timestamp: `Attestor ${idx + 1}`,
    });
  });

  // Revoked
  if (credential.revoked) {
    events.push({
      type: 'revoked',
      label: 'Credential Revoked',
      detail: 'This credential has been revoked and is no longer valid.',
      icon: '🚫',
      timestamp: 'Revoked',
    });
  }

  // Expired
  if (expired && credential.expires_at) {
    events.push({
      type: 'expired',
      label: 'Credential Expired',
      detail: `Expired on ${formatTimestamp(credential.expires_at)}`,
      icon: '⏰',
      timestamp: formatTimestamp(credential.expires_at),
    });
  }

  return events;
}
