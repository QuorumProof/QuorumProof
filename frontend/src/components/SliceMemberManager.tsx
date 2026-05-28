import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

export interface SliceMember {
  id: string;
  address: string;
  role: string;
  reputationScore: number; // 0–100
  available: boolean;
}

interface SliceMemberManagerProps {
  members: SliceMember[];
  threshold: number;
  onAddMember: (member: Omit<SliceMember, 'id'>) => void;
  onRemoveMember: (id: string) => void;
  onThresholdChange: (threshold: number) => void;
}

const ROLES = ['University', 'Licensing Body', 'Employer', 'Other'] as const;

function isValidStellarAddress(addr: string) {
  return /^G[A-Z2-7]{55}$/.test(addr.trim());
}

function reputationLabel(score: number): string {
  if (score >= 80) return 'High';
  if (score >= 50) return 'Medium';
  return 'Low';
}

function reputationColor(score: number): string {
  if (score >= 80) return '#10b981';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

export function SliceMemberManager({
  members,
  threshold,
  onAddMember,
  onRemoveMember,
  onThresholdChange,
}: SliceMemberManagerProps) {
  const [addr, setAddr] = useState('');
  const [role, setRole] = useState<string>('University');
  const [reputation, setReputation] = useState(75);
  const [addrError, setAddrError] = useState('');

  function handleAdd(e: FormEvent) {
    e.preventDefault();
    const trimmed = addr.trim();
    if (!trimmed) { setAddrError('Address is required.'); return; }
    if (!isValidStellarAddress(trimmed)) { setAddrError('Must be a valid Stellar address (G…, 56 chars).'); return; }
    if (members.some((m) => m.address === trimmed)) { setAddrError('Address already in slice.'); return; }
    setAddrError('');
    onAddMember({ address: trimmed, role, reputationScore: reputation, available: true });
    setAddr('');
    setReputation(75);
  }

  const requiredSignatures = threshold;
  const totalMembers = members.length;

  return (
    <div className="slice-member-manager" data-testid="slice-member-manager">
      {/* ── Add Member Form ── */}
      <section aria-label="Add attestor">
        <h4 className="smm__section-title">Add Attestor</h4>
        <form onSubmit={handleAdd} noValidate aria-label="Add attestor form">
          <div className="form-row">
            <label htmlFor="smm-addr" className="form-label">Stellar Address</label>
            <input
              id="smm-addr"
              type="text"
              placeholder="GABC…XYZ"
              value={addr}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { setAddr(e.target.value); setAddrError(''); }}
              aria-invalid={!!addrError}
              aria-describedby={addrError ? 'smm-addr-err' : undefined}
              autoComplete="off"
            />
            {addrError && <p id="smm-addr-err" className="issue-form__field-error" role="alert">{addrError}</p>}
          </div>
          <div className="form-row">
            <label htmlFor="smm-role" className="form-label">Role</label>
            <select id="smm-role" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Attestor role">
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="smm-rep" className="form-label">
              Reputation Score: <strong style={{ color: reputationColor(reputation) }}>{reputation} ({reputationLabel(reputation)})</strong>
            </label>
            <input
              id="smm-rep"
              type="range"
              min={0}
              max={100}
              value={reputation}
              onChange={(e) => setReputation(Number(e.target.value))}
              aria-label="Reputation score"
            />
          </div>
          <button type="submit" className="btn btn--ghost btn--sm" style={{ width: '100%', marginTop: 8 }}>
            + Add to Slice
          </button>
        </form>
      </section>

      <div className="divider" />

      {/* ── Member List ── */}
      <section aria-label="Attestor list">
        <h4 className="smm__section-title">Attestors ({totalMembers})</h4>
        {totalMembers === 0 ? (
          <p className="qsb__empty">No attestors added yet.</p>
        ) : (
          <ul className="smm__member-list" aria-label="Slice members">
            {members.map((m) => (
              <li key={m.id} className="smm__member-item" data-testid={`member-${m.id}`}>
                <div className="smm__member-info">
                  <span className="smm__member-addr mono" title={m.address}>
                    {m.address.slice(0, 8)}…{m.address.slice(-6)}
                  </span>
                  <span className="smm__member-role">{m.role}</span>
                </div>
                <div className="smm__member-rep" title={`Reputation: ${m.reputationScore}`}>
                  <span
                    className="smm__rep-badge"
                    style={{ color: reputationColor(m.reputationScore) }}
                    aria-label={`Reputation score ${m.reputationScore}`}
                  >
                    ★ {m.reputationScore}
                  </span>
                  <span className="smm__rep-label" style={{ color: reputationColor(m.reputationScore) }}>
                    {reputationLabel(m.reputationScore)}
                  </span>
                </div>
                <button
                  className="qsb__remove-btn"
                  onClick={() => onRemoveMember(m.id)}
                  aria-label={`Remove ${m.role} ${m.address.slice(0, 8)}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="divider" />

      {/* ── Threshold / Required Signatures ── */}
      <section aria-label="Threshold settings">
        <h4 className="smm__section-title">Required Signatures</h4>
        <div className="smm__threshold-info">
          <div className="meta-row">
            <span className="meta-label">Threshold</span>
            <span className="meta-value" data-testid="threshold-display">
              {requiredSignatures} / {totalMembers || '—'}
            </span>
          </div>
          <div className="meta-row">
            <span className="meta-label">Required signatures</span>
            <span className="meta-value">{requiredSignatures}</span>
          </div>
        </div>
        {totalMembers > 0 && (
          <div className="form-row" style={{ marginTop: 8 }}>
            <label htmlFor="smm-threshold" className="form-label">Minimum signatures required</label>
            <input
              id="smm-threshold"
              type="number"
              min={1}
              max={totalMembers}
              value={threshold}
              onChange={(e) => onThresholdChange(parseInt(e.target.value, 10) || 1)}
              aria-label="Attestation threshold"
            />
          </div>
        )}
      </section>
    </div>
  );
}
