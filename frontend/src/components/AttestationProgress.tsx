/**
 * AttestationProgress — issue #468
 * Shows signed vs pending attestors and estimated time to completion.
 */
import type { QuorumSlice } from '../lib/contracts/quorumProof';
import { formatAddress } from '../lib/credentialUtils';

interface AttestationProgressProps {
  attestors: string[];       // addresses that have already signed
  slice: QuorumSlice | null; // full slice (provides all expected attestors + threshold)
}

/** Rough estimate: assume each pending attestor takes ~24 h */
export function estimateCompletion(pendingCount: number): string {
  if (pendingCount <= 0) return 'Complete';
  const hours = pendingCount * 24;
  if (hours < 48) return `~${hours}h`;
  return `~${Math.ceil(hours / 24)} days`;
}

export function AttestationProgress({ attestors, slice }: AttestationProgressProps) {
  const signedSet = new Set(attestors);
  const allAttestors: string[] = slice?.attestors ?? attestors;
  const threshold = slice?.threshold ?? attestors.length;
  const signedCount = attestors.length;
  const pendingCount = Math.max(0, threshold - signedCount);
  const pct = threshold > 0 ? Math.min(100, (signedCount / threshold) * 100) : 100;
  const complete = signedCount >= threshold && threshold > 0;

  return (
    <div className="attestation-progress" aria-label="Attestation progress">
      {/* Progress bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
        <span>Quorum Progress</span>
        <span aria-live="polite">{signedCount}/{threshold}</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={signedCount}
        aria-valuemin={0}
        aria-valuemax={threshold}
        aria-label={`Attestation progress: ${signedCount} of ${threshold}`}
        style={{ height: '6px', background: 'var(--bg-surface)', borderRadius: '3px', overflow: 'hidden', marginBottom: '16px' }}
      >
        <div style={{
          height: '100%',
          width: `${pct}%`,
          background: complete ? 'var(--green)' : 'var(--accent-primary)',
          borderRadius: '3px',
          transition: 'width 0.4s ease',
        }} />
      </div>

      {/* Estimated time */}
      {!complete && (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
          Estimated time to completion:{' '}
          <strong data-testid="eta">{estimateCompletion(pendingCount)}</strong>
        </div>
      )}

      {/* Attestor list */}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Attestor status list">
        {allAttestors.map((addr) => {
          const signed = signedSet.has(addr);
          return (
            <li key={addr} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span aria-hidden="true">{signed ? '✅' : '⏳'}</span>
              <span style={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }} title={addr}>
                {formatAddress(addr)}
              </span>
              <span
                style={{ fontSize: '11px', color: signed ? 'var(--green)' : 'var(--text-muted)' }}
                role="status"
                aria-label={`${addr} ${signed ? 'signed' : 'pending'}`}
              >
                {signed ? 'Signed' : 'Pending'}
              </span>
            </li>
          );
        })}
        {/* Pending slots when slice has more attestors than signed */}
        {!slice && pendingCount > 0 && Array.from({ length: pendingCount }).map((_, i) => (
          <li key={`pending-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <span aria-hidden="true">⏳</span>
            <span style={{ flex: 1, fontSize: '13px', color: 'var(--text-muted)' }}>Awaiting attestor</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Pending</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
