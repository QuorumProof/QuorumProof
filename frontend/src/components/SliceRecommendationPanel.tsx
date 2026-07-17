import { useState } from 'react';
import {
  recommendSlice,
  type AttestorCandidate,
  type SliceRecommendation,
  type RecommendationContext,
} from '../lib/sliceRecommendation';

const CREDENTIAL_TYPE_LABELS: Record<number, string> = {
  1: '🎓 Degree',
  2: '🏛️ License',
  3: '💼 Employment',
  4: '📜 Certification',
  5: '🔬 Research',
};

interface SliceRecommendationPanelProps {
  candidates: AttestorCandidate[];
  onAccept: (recommendation: SliceRecommendation) => void;
  context?: RecommendationContext;
}

export function SliceRecommendationPanel({
  candidates,
  onAccept,
  context = {},
}: SliceRecommendationPanelProps) {
  const [recommendation] = useState<SliceRecommendation | null>(
    () => recommendSlice(candidates, 3, context)
  );
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
    const nextReasons = { ...active.reasons };
    delete nextReasons[address];
    setCustomized({
      attestors: next,
      threshold: Math.min(active.threshold, next.length),
      score: Math.round(next.reduce((s, a) => s + a.reputationScore, 0) / next.length),
      reasons: nextReasons,
    });
  }

  function handleAccept() {
    onAccept(active!);
    setAccepted(true);
  }

  const hasContext =
    context.credentialType != null ||
    !!context.industry ||
    (context.history != null && Object.keys(context.history).length > 0);

  return (
    <div className="srp" data-testid="slice-recommendation-panel">
      <div className="srp__header">
        <h4 className="srp__title">Recommended Slice</h4>
        <span className="srp__score" data-testid="recommendation-score">
          Score: {active.score}/100
        </span>
      </div>

      {/* Context badges */}
      {hasContext && (
        <div className="srp__context" data-testid="srp-context">
          {context.credentialType != null && (
            <span className="srp__badge" data-testid="srp-badge-credtype">
              {CREDENTIAL_TYPE_LABELS[context.credentialType] ?? `Type ${context.credentialType}`}
            </span>
          )}
          {context.industry && (
            <span className="srp__badge srp__badge--industry" data-testid="srp-badge-industry">
              🏭 {context.industry}
            </span>
          )}
          {context.history && Object.keys(context.history).length > 0 && (
            <span className="srp__badge srp__badge--history" data-testid="srp-badge-history">
              🕐 history-aware
            </span>
          )}
        </div>
      )}

      <p className="srp__desc">
        {hasContext
          ? 'Tailored to your credential type and industry. Remove attestors to customize.'
          : 'Based on reputation and availability. Remove attestors to customize.'}
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
            {active.reasons[a.address] && (
              <span className="srp__reason" data-testid={`rec-reason-${a.address.slice(0, 8)}`}>
                {active.reasons[a.address]}
              </span>
            )}
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
        <button
          className="btn btn--primary btn--sm"
          onClick={handleAccept}
          data-testid="accept-recommendation"
        >
          Accept Recommendation
        </button>
      </div>
    </div>
  );
}
