import { useMemo, useState } from 'react';
import type { AttestorEntry } from '../lib/sliceBuilderUtils';
import { consensusSummary } from '../lib/sliceBuilderUtils';
import {
  evaluateScenario,
  scenarioStats,
  faultTolerance,
  minimalWinningCoalitions,
  MAX_ENUM_ATTESTORS,
} from '../lib/sliceSimulator';

function fmt(addr: string) {
  return addr ? addr.slice(0, 8) + '…' + addr.slice(-6) : '(no address)';
}

export interface SliceSimulatorProps {
  attestors: AttestorEntry[];
  threshold: number;
}

/**
 * Interactive preview of attestation outcomes. The user toggles which attestors
 * sign and immediately sees whether the slice would reach consensus, alongside
 * resilience stats for the configuration as a whole.
 */
export function SliceSimulator({ attestors, threshold }: SliceSimulatorProps) {
  // Track who is explicitly *not* signing; everyone signs by default, so newly
  // added attestors are included automatically.
  const [unsigned, setUnsigned] = useState<Set<string>>(() => new Set());

  const signedIds = useMemo(() => {
    const s = new Set<string>();
    for (const a of attestors) if (!unsigned.has(a.id)) s.add(a.id);
    return s;
  }, [attestors, unsigned]);

  const result = useMemo(
    () => evaluateScenario(attestors, threshold, signedIds),
    [attestors, threshold, signedIds],
  );
  const stats = useMemo(() => scenarioStats(attestors, threshold), [attestors, threshold]);
  const tolerance = useMemo(() => faultTolerance(attestors, threshold), [attestors, threshold]);
  const { minSigners } = useMemo(
    () => consensusSummary(threshold, attestors),
    [threshold, attestors],
  );
  const minimal = useMemo(
    () => minimalWinningCoalitions(attestors, threshold),
    [attestors, threshold],
  );

  function toggle(id: string) {
    setUnsigned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function allSign() {
    setUnsigned(new Set());
  }
  function noneSign() {
    setUnsigned(new Set(attestors.map((a) => a.id)));
  }
  function minimalSign() {
    const coalition = minimal[0];
    if (!coalition) return;
    const keep = new Set(coalition.map((a) => a.id));
    setUnsigned(new Set(attestors.filter((a) => !keep.has(a.id)).map((a) => a.id)));
  }

  if (attestors.length === 0) {
    return <p className="qsb__empty">Add attestors to simulate attestation scenarios.</p>;
  }

  const bannerClass = result.success ? 'status-banner--valid' : 'status-banner--revoked';

  return (
    <div className="qsb__sim" aria-label="Attestation scenario simulator">
      {/* Outcome */}
      <div className={`status-banner ${bannerClass}`} role="status" aria-live="polite">
        <div className="status-banner__icon">{result.success ? '✅' : '❌'}</div>
        <div>
          <div className="status-banner__title">
            {result.success ? 'Consensus Reached' : 'Consensus Not Reached'}
          </div>
          <div className="status-banner__sub">
            Signed weight {result.signedWeight} / {result.threshold} required ({result.percentOfThreshold}%).{' '}
            {result.success
              ? result.surplus > 0
                ? `${result.surplus} weight to spare.`
                : 'Exactly at threshold.'
              : `${result.deficit} more weight needed.`}
          </div>
        </div>
      </div>

      {/* Quick scenarios */}
      <div className="qsb__sim-actions" role="group" aria-label="Quick scenarios">
        <button type="button" className="btn btn--ghost btn--sm" onClick={allSign}>
          All sign
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={noneSign}>
          None sign
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={minimalSign}
          disabled={minimal.length === 0}
          title={
            minimal.length === 0
              ? 'No combination of signers can reach this threshold.'
              : 'Select a smallest sufficient set of signers.'
          }
        >
          Minimum to pass
        </button>
      </div>

      {/* Per-attestor signing toggles */}
      <ul className="qsb__sim-list" aria-label="Toggle which attestors sign">
        {attestors.map((a) => {
          const isSigned = !unsigned.has(a.id);
          return (
            <li key={a.id} className="qsb__sim-item">
              <label className="qsb__sim-toggle">
                <input
                  type="checkbox"
                  checked={isSigned}
                  onChange={() => toggle(a.id)}
                  aria-label={`${a.role} ${fmt(a.address)} signs (weight ${a.weight})`}
                />
                <span className="qsb__sim-item__addr mono" title={a.address}>
                  {fmt(a.address)}
                </span>
                <span className="qsb__sim-item__role">{a.role}</span>
                <span className="qsb__sim-item__weight" aria-hidden="true">
                  ⚖️ {a.weight}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {/* Resilience stats */}
      <div className="qsb__sim-stats" aria-label="Configuration resilience">
        <div className="qsb__sim-stat">
          <span className="qsb__sim-stat__value">{minSigners}</span>
          <span className="qsb__sim-stat__label">Min. signers to pass</span>
        </div>
        <div className="qsb__sim-stat">
          <span className="qsb__sim-stat__value">{tolerance}</span>
          <span className="qsb__sim-stat__label">Attestors that can drop</span>
        </div>
        <div className="qsb__sim-stat">
          <span className="qsb__sim-stat__value">
            {stats.enumerated ? `${stats.winningScenarios}/${stats.totalScenarios}` : '—'}
          </span>
          <span className="qsb__sim-stat__label">
            {stats.enumerated
              ? `Winning combinations (${stats.winRatePct}%)`
              : `Too many to enumerate (>${MAX_ENUM_ATTESTORS})`}
          </span>
        </div>
      </div>

      {/* Minimal winning coalitions */}
      {minimal.length > 0 && (
        <div className="qsb__sim-coalitions">
          <p className="qsb__sim-coalitions__title">Smallest sufficient signer sets</p>
          <ul aria-label="Minimal winning coalitions">
            {minimal.slice(0, 6).map((coalition, idx) => (
              <li key={idx} className="qsb__sim-coalition">
                {coalition.map((a) => `${a.role} (${a.weight})`).join(' + ')}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
