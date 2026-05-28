import { useState } from 'react';
import { recommendSlice, type AttestorCandidate, type SliceRecommendation } from '../lib/sliceRecommendation';

interface SliceRecommendationPanelProps {
  candidates: AttestorCandidate[];
  onAccept: (recommendation: SliceRecommendation) => void;
}

export function SliceRecommendationPanel({ candidates, onAccept }: SliceRecommendationPanelProps) {
  const [recommendation] = useState<SliceRecommendation | null>(() => recommendSlice(candidates));
  const [customized, setCustomized] = useState<SliceRecommendation | null>(null);
  const [accepted, setAccepted] = useState(false);

  const active = customized ?? recommendation;

  if (!active) {
    return (
      <div className="srp srp--empty" data-testid="srp-empty">
        <p>No candidates available for recommendation.</p>
      </div>
    );
  }

  if (accepted) {
    return (
      <div className="srp srp--accepted" data-testid="srp-accepted">
        <span>✅ Recommended slice applied ({active.attestors.length} attestors, threshold {active.threshold})</span>
      </div>
    );
  }

  function handleRemove(address: string) {
    if (!active) return;
    const next = active.attestors.filter((a) => a.address !== address);
    if (next.length === 0) return;
    setCustomized({
      attestors: next,
      threshold: Math.min(active.threshold, next.length),
      score: Math.round(next.reduce((s, a) => s + a.reputationScore, 0) / next.length),
    });
  }

  function handleAccept() {
    onAccept(active!);
    setAccepted(true);
  }

  return (
    <div className="srp" data-testid="slice-recommendation-panel">
      <div className="srp__header">
        <h4 className="srp__title">Recommended Slice</h4>
        <span className="srp__score" data-testid="recommendation-score">
          Score: {active.score}/100
        </span>
      </div>
      <p className="srp__desc">
        Based on reputation and availability. You can remove attestors to customize.
      </p>

      <ul className="srp__list" aria-label="Recommended attestors">
        {active.attestors.map((a) => (
          <li key={a.address} className="srp__item" data-testid={`rec-attestor-${a.address.slice(0, 8)}`}>
            <div className="srp__item-info">
              <span className="mono srp__addr" title={a.address}>{a.address.slice(0, 8)}…</span>
              <span className="srp__role">{a.role}</span>
              <span className="srp__rep">★ {a.reputationScore}</span>
              {!a.available && <span className="srp__unavailable">Unavailable</span>}
            </div>
            <button
              className="qsb__remove-btn"
              onClick={() => handleRemove(a.address)}
              aria-label={`Remove ${a.role} from recommendation`}
              disabled={active.attestors.length <= 1}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      <div className="srp__threshold">
        Suggested threshold: <strong data-testid="rec-threshold">{active.threshold}</strong> of {active.attestors.length}
      </div>

      <div className="srp__actions">
        <button className="btn btn--primary btn--sm" onClick={handleAccept} data-testid="accept-recommendation">
          Accept Recommendation
        </button>
      </div>
    </div>
  );
}
