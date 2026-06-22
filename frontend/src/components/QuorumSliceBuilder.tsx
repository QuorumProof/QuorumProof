import { useState, useEffect, useCallback, useRef } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';
import { createSlice } from '../lib/contracts/quorumProof';
import { useToast } from '../context/ToastContext';
import {
  PRESETS,
  saveDraft,
  loadDraft,
  clearDraft,
  encodeSliceToUrl,
  totalWeight,
  thresholdPercent,
  consensusSummary,
} from '../lib/sliceBuilderUtils';
import type { AttestorEntry } from '../lib/sliceBuilderUtils';

// ── Constants ────────────────────────────────────────────────────────────────

const ROLES = ['University', 'Licensing Body', 'Employer', 'Other'] as const;
type Role = (typeof ROLES)[number];

const ROLE_ICONS: Record<string, string> = {
  University: '🎓',
  'Licensing Body': '🏛️',
  Employer: '💼',
  Other: '🔹',
};

/** Known attestor candidates for search */
const KNOWN_ATTESTORS = [
  { address: 'GABC1UNIVERSITY1111111111111111111111111111111111111111A', role: 'University', label: 'MIT - Massachusetts Institute of Technology' },
  { address: 'GABC2UNIVERSITY2222222222222222222222222222222222222222B', role: 'University', label: 'University of São Paulo' },
  { address: 'GABC3LICENSING33333333333333333333333333333333333333333C', role: 'Licensing Body', label: 'CREA Brazil' },
  { address: 'GABC4LICENSING44444444444444444444444444444444444444444D', role: 'Licensing Body', label: 'Engineers Canada' },
  { address: 'GABC5EMPLOYER555555555555555555555555555555555555555555E', role: 'Employer', label: 'Acme Corp' },
  { address: 'GABC6EMPLOYER666666666666666666666666666666666666666666F', role: 'Employer', label: 'GlobalTech Ltd' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr.trim());
}

function fmt(addr: string) {
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

function Tooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="qsb-tooltip-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
      role="tooltip"
      aria-label={text}
    >
      <span className="qsb-tooltip-icon" aria-hidden="true">ⓘ</span>
      {open && <span className="qsb-tooltip-bubble" role="status">{text}</span>}
    </span>
  );
}

// ── Search Box ───────────────────────────────────────────────────────────────

interface SearchBoxProps {
  query: string;
  onChange: (v: string) => void;
  onSelect: (candidate: typeof KNOWN_ATTESTORS[0]) => void;
}

function AttestorSearchBox({ query, onChange, onSelect }: SearchBoxProps) {
  const [focused, setFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);

  const results = query.trim().length >= 2
    ? KNOWN_ATTESTORS.filter(
        (c) =>
          c.label.toLowerCase().includes(query.toLowerCase()) ||
          c.address.toLowerCase().includes(query.toLowerCase()) ||
          c.role.toLowerCase().includes(query.toLowerCase())
      )
    : [];

  const showDropdown = focused && results.length > 0;

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (!showDropdown) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, results.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); onSelect(results[activeIdx]); setActiveIdx(-1); }
    if (e.key === 'Escape') setActiveIdx(-1);
  }

  return (
    <div className="qsb-search-wrap" role="combobox" aria-expanded={showDropdown} aria-haspopup="listbox">
      <span className="input-icon" aria-hidden="true">🔍</span>
      <input
        type="text"
        value={query}
        placeholder="Search by name, role, or address…"
        aria-label="Search known attestors"
        aria-autocomplete="list"
        autoComplete="off"
        onChange={(e: ChangeEvent<HTMLInputElement>) => { onChange(e.target.value); setActiveIdx(-1); }}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        onKeyDown={handleKey}
      />
      {showDropdown && (
        <ul
          className="qsb-search-dropdown"
          role="listbox"
          aria-label="Attestor suggestions"
          ref={listRef}
        >
          {results.map((c, i) => (
            <li
              key={c.address}
              role="option"
              aria-selected={i === activeIdx}
              className={`qsb-search-item${i === activeIdx ? ' qsb-search-item--active' : ''}`}
              onMouseDown={() => onSelect(c)}
            >
              <span className="qsb-search-item__icon" aria-hidden="true">{ROLE_ICONS[c.role]}</span>
              <span className="qsb-search-item__label">{c.label}</span>
              <span className="qsb-search-item__role">{c.role}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Consensus Visualizer ─────────────────────────────────────────────────────

function ConsensusBar({ attestors, threshold }: { attestors: AttestorEntry[]; threshold: number }) {
  const tw = totalWeight(attestors);
  const pct = thresholdPercent(threshold, attestors);
  const { minSigners } = consensusSummary(threshold, attestors);
  const color = pct >= 100 ? '#ef4444' : pct >= 67 ? '#10b981' : '#f59e0b';

  return (
    <div className="qsb-consensus" aria-label="Consensus threshold visualizer">
      <div className="qsb-consensus__labels">
        <span>
          Threshold{' '}
          <Tooltip text="The minimum total weight needed from co-signing attestors for the slice to reach consensus." />
        </span>
        <span style={{ color }}>
          {threshold} / {tw} weight ({pct}%)
        </span>
      </div>
      <div className="qsb-consensus__track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="qsb-consensus__fill" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
        <div className="qsb-consensus__marker" style={{ left: `${Math.min(pct, 100)}%` }} />
      </div>
      {attestors.length > 0 && (
        <p className="qsb-consensus__hint">
          At minimum, <strong>{minSigners}</strong> attestor{minSigners !== 1 ? 's' : ''} must sign (by highest weight).
        </p>
      )}
    </div>
  );
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface QuorumSliceBuilderProps {
  creatorAddress: string;
  initialAttestors?: AttestorEntry[];
  initialThreshold?: number;
}

// ── Main Component ────────────────────────────────────────────────────────────

export function QuorumSliceBuilder({ creatorAddress, initialAttestors, initialThreshold }: QuorumSliceBuilderProps) {
  const { addToast, removeToast } = useToast();

  // ── State ──────────────────────────────────────────────────────────────────
  const [attestors, setAttestors] = useState<AttestorEntry[]>(() => {
    if (initialAttestors?.length) return initialAttestors;
    const draft = loadDraft();
    return draft?.attestors ?? [];
  });
  const [threshold, setThreshold] = useState<number>(() => {
    if (initialThreshold != null) return initialThreshold;
    return loadDraft()?.threshold ?? 1;
  });

  // Add-attestor form
  const [addrInput, setAddrInput] = useState('');
  const [roleInput, setRoleInput] = useState<Role>('University');
  const [weightInput, setWeightInput] = useState(1);
  const [addrError, setAddrError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // UI state
  const [thresholdError, setThresholdError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [success, setSuccess] = useState<{ sliceId: bigint } | null>(null);
  const [copied, setCopied] = useState(false);

  // ── Auto-save draft ────────────────────────────────────────────────────────
  useEffect(() => {
    if (attestors.length > 0) saveDraft({ attestors, threshold });
  }, [attestors, threshold]);

  // ── Threshold validation ───────────────────────────────────────────────────
  const tw = totalWeight(attestors);
  useEffect(() => {
    if (attestors.length === 0) { setThresholdError(''); return; }
    if (threshold < 1) setThresholdError('Threshold must be at least 1.');
    else if (threshold > tw) setThresholdError(`Threshold cannot exceed total weight (${tw}).`);
    else setThresholdError('');
  }, [threshold, tw, attestors.length]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const addAttestor = useCallback((entry: Omit<AttestorEntry, 'id'>) => {
    const trimmed = entry.address.trim();
    if (!isValidStellarAddress(trimmed)) { setAddrError('Must be a valid Stellar address (G…, 56 chars).'); return; }
    if (attestors.some((a) => a.address === trimmed)) { setAddrError('Address already in slice.'); return; }
    setAddrError('');
    setAttestors((prev) => [...prev, { ...entry, address: trimmed, id: crypto.randomUUID() }]);
    setAddrInput('');
    setSearchQuery('');
  }, [attestors]);

  function handleAddForm(e: FormEvent) {
    e.preventDefault();
    if (!addrInput.trim()) { setAddrError('Address is required.'); return; }
    addAttestor({ address: addrInput, role: roleInput, weight: weightInput });
  }

  function handleSearchSelect(candidate: typeof KNOWN_ATTESTORS[0]) {
    setAddrInput(candidate.address);
    setRoleInput(candidate.role as Role);
    setSearchQuery(candidate.label);
    setAddrError('');
  }

  function handleWeightChange(id: string, val: number) {
    setAttestors((prev) => prev.map((a) => a.id === id ? { ...a, weight: Math.max(1, Math.min(10, val)) } : a));
  }

  function handleRemove(id: string) {
    setAttestors((prev) => {
      const next = prev.filter((a) => a.id !== id);
      const newTw = next.reduce((s, a) => s + a.weight, 0);
      if (threshold > newTw && newTw > 0) setThreshold(newTw);
      return next;
    });
  }

  function handlePreset(presetId: string) {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setAttestors(preset.attestors.map((a) => ({ ...a, id: crypto.randomUUID() })));
    setThreshold(preset.threshold);
    setAddrError('');
    setThresholdError('');
  }

  function handleCopyUrl() {
    const url = encodeSliceToUrl({ attestors, threshold });
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (attestors.length === 0 || thresholdError) return;
    setSubmitError('');
    setSubmitting(true);
    const pendingId = addToast({ type: 'pending', message: 'Transaction pending…' });
    try {
      const sliceId = await createSlice(creatorAddress, attestors.map((a) => a.address), threshold);
      removeToast(pendingId);
      addToast({ type: 'success', message: 'Quorum slice created.', explorerUrl: `https://stellar.expert/explorer/testnet/tx/${sliceId}` });
      clearDraft();
      setSuccess({ sliceId });
    } catch (err: unknown) {
      removeToast(pendingId);
      const msg = err instanceof Error ? err.message : 'Failed to create slice.';
      addToast({ type: 'error', message: `Transaction failed: ${msg}` });
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset() {
    setAttestors([]); setThreshold(1); setAddrError('');
    setThresholdError(''); setSubmitError(''); setSuccess(null);
    clearDraft();
  }

  // ── Success screen ─────────────────────────────────────────────────────────
  if (success) {
    return (
      <div className="qsb-success" role="status" aria-live="polite">
        <div className="status-banner status-banner--valid">
          <div className="status-banner__icon">✅</div>
          <div>
            <div className="status-banner__title">Quorum Slice Created</div>
            <div className="status-banner__sub">
              Slice #{success.sliceId.toString()} — {attestors.length} attestor{attestors.length !== 1 ? 's' : ''}, threshold {threshold}.
            </div>
          </div>
        </div>
        <button className="btn btn--ghost" style={{ marginTop: 16 }} onClick={handleReset}>Build Another Slice</button>
      </div>
    );
  }

  const canSubmit = attestors.length > 0 && !thresholdError && threshold >= 1;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="qsb">

      {/* ── Presets ── */}
      <section className="qsb__section" aria-label="Preset templates">
        <div className="qsb__section-header">
          <span className="detail-card__title">Preset Templates</span>
          <Tooltip text="Start with a recommended configuration for common trust scenarios." />
        </div>
        <div className="qsb__presets">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="qsb__preset-btn"
              onClick={() => handlePreset(p.id)}
              title={p.description}
              aria-label={`Apply preset: ${p.label}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      <div className="divider" />

      {/* ── Search / Add Attestor ── */}
      <section className="qsb__section" aria-label="Add attestor">
        <div className="qsb__section-header">
          <span className="detail-card__title">Add Attestor</span>
          <Tooltip text="Attestors are entities that co-sign your credential. Each has a weight influencing consensus." />
        </div>

        {/* Known-attestor search */}
        <div className="form-row">
          <label className="form-label">Search Known Attestors</label>
          <AttestorSearchBox
            query={searchQuery}
            onChange={setSearchQuery}
            onSelect={handleSearchSelect}
          />
        </div>

        <form onSubmit={handleAddForm} noValidate>
          <div className="form-row">
            <label htmlFor="qsb-addr" className="form-label">Stellar Address</label>
            <div className="input-wrap">
              <span className="input-icon" aria-hidden="true">👤</span>
              <input
                id="qsb-addr"
                type="text"
                placeholder="GABC…XYZ"
                value={addrInput}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!addrError}
                aria-describedby={addrError ? 'qsb-addr-err' : undefined}
                onChange={(e: ChangeEvent<HTMLInputElement>) => { setAddrInput(e.target.value); setAddrError(''); }}
              />
            </div>
            {addrError && <p id="qsb-addr-err" className="issue-form__field-error" role="alert">{addrError}</p>}
          </div>

          <div className="qsb__row2">
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label htmlFor="qsb-role" className="form-label">Role</label>
              <div className="input-wrap">
                <span className="input-icon" aria-hidden="true">{ROLE_ICONS[roleInput]}</span>
                <select id="qsb-role" value={roleInput} onChange={(e: ChangeEvent<HTMLSelectElement>) => setRoleInput(e.target.value as Role)} aria-label="Attestor role">
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_ICONS[r]} {r}</option>)}
                </select>
              </div>
            </div>

            <div className="form-row" style={{ marginBottom: 0 }}>
              <label htmlFor="qsb-weight" className="form-label">
                Weight{' '}
                <Tooltip text="Weight determines how much this attestor's signature counts toward the consensus threshold. Range: 1–10." />
              </label>
              <div className="input-wrap">
                <span className="input-icon" aria-hidden="true">⚖️</span>
                <input
                  id="qsb-weight"
                  type="number"
                  min={1}
                  max={10}
                  value={weightInput}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setWeightInput(Number(e.target.value))}
                  aria-label="Attestor weight"
                />
              </div>
            </div>
          </div>

          <button type="submit" className="btn btn--ghost btn--sm" style={{ marginTop: 16, width: '100%' }}>
            + Add to Slice
          </button>
        </form>
      </section>

      <div className="divider" />

      {/* ── Attestor List ── */}
      <section className="qsb__section" aria-label="Attestor list">
        <div className="qsb__section-header">
          <span className="detail-card__title">Attestors ({attestors.length})</span>
          <Tooltip text="Adjust each attestor's weight with the slider or input. Higher weight = more influence on consensus." />
        </div>
        {attestors.length === 0 ? (
          <p className="qsb__empty">No attestors added yet.</p>
        ) : (
          <ul className="qsb__attestor-list" aria-label="Added attestors">
            {attestors.map((a) => (
              <li key={a.id} className="qsb__attestor-item">
                <span className="qsb__attestor-icon" aria-hidden="true">{ROLE_ICONS[a.role] ?? '🔹'}</span>
                <div className="qsb__attestor-info">
                  <span className="qsb__attestor-addr mono" title={a.address}>{fmt(a.address)}</span>
                  <span className="qsb__attestor-role">{a.role}</span>
                </div>
                <div className="qsb__weight-ctrl" aria-label={`Weight for ${fmt(a.address)}`}>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={a.weight}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => handleWeightChange(a.id, Number(e.target.value))}
                    aria-label={`Weight slider for ${fmt(a.address)}`}
                  />
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={a.weight}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => handleWeightChange(a.id, Number(e.target.value))}
                    aria-label={`Weight value for ${fmt(a.address)}`}
                    className="qsb__weight-num"
                  />
                </div>
                <button
                  className="qsb__remove-btn"
                  onClick={() => handleRemove(a.id)}
                  aria-label={`Remove ${a.role} ${fmt(a.address)}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="divider" />

      {/* ── Threshold ── */}
      <section className="qsb__section" aria-label="Threshold configuration">
        <div className="qsb__section-header">
          <span className="detail-card__title">Consensus Threshold</span>
          <Tooltip text="Minimum total weight required for consensus. Must be between 1 and the sum of all attestor weights." />
        </div>
        <div className="form-row">
          <label htmlFor="qsb-threshold" className="form-label">Minimum weight to reach consensus</label>
          <div className="input-wrap">
            <span className="input-icon" aria-hidden="true">🔢</span>
            <input
              id="qsb-threshold"
              type="number"
              min={1}
              max={tw || 1}
              value={threshold}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setThreshold(Number(e.target.value))}
              aria-invalid={!!thresholdError}
              aria-describedby={thresholdError ? 'qsb-threshold-err' : 'qsb-threshold-hint'}
            />
          </div>
          {thresholdError
            ? <p id="qsb-threshold-err" className="issue-form__field-error" role="alert">{thresholdError}</p>
            : <p id="qsb-threshold-hint" className="issue-form__hint">Total weight: {tw}.</p>}
        </div>

        {attestors.length > 0 && (
          <ConsensusBar attestors={attestors} threshold={threshold} />
        )}
      </section>

      <div className="divider" />

      {/* ── Share ── */}
      {attestors.length > 0 && (
        <section className="qsb__section" aria-label="Share slice">
          <div className="qsb__section-header">
            <span className="detail-card__title">Share / Save</span>
            <Tooltip text="Copy a URL that encodes this slice configuration so others can load it directly." />
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ width: '100%' }}
            onClick={handleCopyUrl}
            aria-live="polite"
            aria-label="Copy shareable URL for this slice"
          >
            {copied ? '✅ Copied!' : '🔗 Copy Shareable URL'}
          </button>
          <p className="issue-form__hint" style={{ marginTop: 8 }}>Draft is auto-saved to your browser.</p>
        </section>
      )}

      {attestors.length > 0 && <div className="divider" />}

      {/* ── Submit ── */}
      {submitError && (
        <div className="error-card" role="alert" style={{ marginBottom: 12 }}>
          <span className="error-card__icon">⚠️</span>
          <div>
            <div className="error-card__title">Transaction Failed</div>
            <div className="error-card__msg">{submitError}</div>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <button
          type="submit"
          className="btn btn--primary"
          style={{ width: '100%' }}
          disabled={!canSubmit || submitting}
          aria-busy={submitting}
        >
          {submitting ? (
            <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} aria-hidden="true" /> Creating…</>
          ) : 'Create Quorum Slice'}
        </button>
      </form>
    </div>
  );
}
