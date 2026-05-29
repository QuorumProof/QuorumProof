import { useState, useMemo } from 'react';
import { formatAddress, attestorRole } from '../lib/credentialUtils';

export interface AttestorReputation {
  address: string;
  score: number;        // 0–100
  attestationCount: number;
  lastAttestedAt?: number; // Unix timestamp (seconds)
}

interface Props {
  attestors: string[];
  /** Optional reputation data keyed by address. Falls back to derived scores. */
  reputationData?: Record<string, Omit<AttestorReputation, 'address'>>;
  minReputationFilter?: number;
}

function scoreLabel(score: number): string {
  if (score >= 80) return 'High';
  if (score >= 50) return 'Medium';
  return 'Low';
}

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--green, #10b981)';
  if (score >= 50) return 'var(--yellow, #f59e0b)';
  return 'var(--red, #ef4444)';
}

/** Derive a deterministic pseudo-score from an address when no real data is available. */
function deriveScore(address: string): number {
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = (hash * 31 + address.charCodeAt(i)) >>> 0;
  }
  return 40 + (hash % 61); // 40–100
}

export function AttestorReputationDisplay({ attestors, reputationData = {}, minReputationFilter = 0 }: Props) {
  const [filter, setFilter] = useState(minReputationFilter);

  const entries: AttestorReputation[] = useMemo(() =>
    attestors.map((address) => {
      const data = reputationData[address];
      return {
        address,
        score: data?.score ?? deriveScore(address),
        attestationCount: data?.attestationCount ?? 0,
        lastAttestedAt: data?.lastAttestedAt,
      };
    }),
    [attestors, reputationData]
  );

  const filtered = useMemo(
    () => entries.filter((e) => e.score >= filter).sort((a, b) => b.score - a.score),
    [entries, filter]
  );

  if (attestors.length === 0) {
    return <div className="attestors-empty">No attestors to display</div>;
  }

  return (
    <div>
      {/* Filter control */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <label htmlFor="rep-filter" style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          Min reputation:
        </label>
        <select
          id="rep-filter"
          value={filter}
          onChange={(e) => setFilter(Number(e.target.value))}
          style={{
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            padding: '4px 8px',
            fontSize: '13px',
          }}
          aria-label="Filter attestors by minimum reputation threshold"
        >
          <option value={0}>All</option>
          <option value={50}>Medium+ (50)</option>
          <option value={80}>High (80+)</option>
        </select>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {filtered.length} of {entries.length} attestor{entries.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Attestor list */}
      {filtered.length === 0 ? (
        <div className="attestors-empty">No attestors meet the reputation threshold</div>
      ) : (
        <ol className="attestor-list" aria-label="Attestor reputation list" style={{ listStyle: 'none', padding: 0 }}>
          {filtered.map((entry, idx) => {
            const color = scoreColor(entry.score);
            const label = scoreLabel(entry.score);
            const originalIdx = attestors.indexOf(entry.address);
            return (
              <li key={entry.address} className="attestor-item">
                <div className="attestor-item__avatar" aria-hidden="true">{idx + 1}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="attestor-item__addr" title={entry.address}>
                    {formatAddress(entry.address)}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {attestorRole(originalIdx)}
                    {entry.attestationCount > 0 && ` · ${entry.attestationCount} attestation${entry.attestationCount !== 1 ? 's' : ''}`}
                    {entry.lastAttestedAt && ` · Last: ${new Date(entry.lastAttestedAt * 1000).toLocaleDateString()}`}
                  </div>
                </div>

                {/* Reputation score */}
                <div style={{ textAlign: 'right', minWidth: '80px' }}>
                  <div
                    style={{ fontSize: '13px', fontWeight: 600, color }}
                    aria-label={`Reputation score ${entry.score}, ${label}`}
                  >
                    ★ {entry.score}
                  </div>
                  <div style={{ fontSize: '11px', color }}>
                    {label}
                  </div>
                  {/* Score bar */}
                  <div
                    role="progressbar"
                    aria-valuenow={entry.score}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Reputation ${entry.score} out of 100`}
                    style={{
                      marginTop: '4px',
                      height: '4px',
                      background: 'var(--bg-surface)',
                      borderRadius: '2px',
                      overflow: 'hidden',
                    }}
                  >
                    <div style={{
                      height: '100%',
                      width: `${entry.score}%`,
                      background: color,
                      borderRadius: '2px',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
