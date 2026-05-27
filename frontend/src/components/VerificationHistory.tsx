import { useState, useMemo } from 'react';
import { formatAddress } from '../lib/credentialUtils';

export interface VerificationRecord {
  id: bigint;
  verifier: string;
  requested_at: bigint;
  claim_types: string[];
}

interface Props {
  records: VerificationRecord[];
}

const FILTER_OPTIONS = [
  { value: 0,   label: 'All time' },
  { value: 24,  label: 'Last 24 hours' },
  { value: 168, label: 'Last 7 days' },
  { value: 720, label: 'Last 30 days' },
];

function formatTs(ts: bigint): string {
  return new Date(Number(ts) * 1000).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function accessLabel(claimTypes: string[]): string {
  if (!claimTypes || claimTypes.length === 0) return 'Full view';
  return claimTypes.join(', ');
}

export function VerificationHistory({ records }: Props) {
  const [filterHours, setFilterHours] = useState(0);

  const filtered = useMemo(() => {
    if (filterHours === 0) return records;
    const cutoff = BigInt(Math.floor(Date.now() / 1000) - filterHours * 3600);
    return records.filter((r) => r.requested_at >= cutoff);
  }, [records, filterHours]);

  // Most recent first
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => (a.requested_at > b.requested_at ? -1 : 1)),
    [filtered],
  );

  return (
    <div aria-label="Verification history">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {sorted.length} verification{sorted.length !== 1 ? 's' : ''}
        </span>
        <select
          aria-label="Filter verifications by time"
          value={filterHours}
          onChange={(e) => setFilterHours(Number(e.target.value))}
          style={{ fontSize: 12 }}
        >
          {FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {sorted.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '16px 0' }}>
          No verifications in this period.
        </p>
      ) : (
        <ol className="attestor-list" aria-label="Verification log" style={{ listStyle: 'none', padding: 0 }}>
          {sorted.map((r) => (
            <li key={r.id.toString()} className="attestor-item" data-testid={`verification-record-${r.id}`}>
              <div className="attestor-item__avatar" aria-hidden="true">🔍</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="attestor-item__addr" title={r.verifier}>
                  {formatAddress(r.verifier)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {accessLabel(r.claim_types)}
                </div>
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {formatTs(r.requested_at)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
