import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { recommendSlice, type AttestorCandidate } from '../../lib/sliceRecommendation';
import { SliceRecommendationPanel } from '../SliceRecommendationPanel';

const candidates: AttestorCandidate[] = [
  { address: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', role: 'University', reputationScore: 90, available: true },
  { address: 'GBCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', role: 'Employer', reputationScore: 70, available: true },
  { address: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', role: 'Licensing Body', reputationScore: 50, available: false },
  { address: 'GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', role: 'Other', reputationScore: 80, available: true },
];

// ── recommendSlice algorithm ──────────────────────────────────────────────────

describe('recommendSlice algorithm (#947)', () => {
  it('returns null for empty candidates', () => {
    expect(recommendSlice([])).toBeNull();
  });

  it('selects up to maxSize candidates', () => {
    const rec = recommendSlice(candidates, 3);
    expect(rec!.attestors).toHaveLength(3);
  });

  it('prioritizes available attestors over unavailable', () => {
    const rec = recommendSlice(candidates, 3);
    const unavailable = rec!.attestors.filter((a) => !a.available);
    expect(unavailable.length).toBeLessThan(rec!.attestors.length);
  });

  it('sets threshold to ceil(n/2)', () => {
    expect(recommendSlice(candidates, 3)!.threshold).toBe(2);
    expect(recommendSlice(candidates, 2)!.threshold).toBe(1);
  });

  it('computes score as average reputation', () => {
    const rec = recommendSlice([candidates[0]], 1);
    expect(rec!.score).toBe(90);
  });

  it('includes a reasons map with an entry per selected attestor', () => {
    const rec = recommendSlice(candidates, 3)!;
    for (const attestor of rec.attestors) {
      expect(rec.reasons[attestor.address]).toBeDefined();
      expect(typeof rec.reasons[attestor.address]).toBe('string');
    }
  });

  // ── credential-type context ─────────────────────────────────────────────

  it('boosts University for credential type 1 (Degree)', () => {
    const pool: AttestorCandidate[] = [
      { address: 'GAAA', role: 'University', reputationScore: 60, available: true },
      { address: 'GBBB', role: 'Employer', reputationScore: 80, available: true },
    ];
    const rec = recommendSlice(pool, 2, { credentialType: 1 })!;
    // University gets +30 bonus → 60+30=90 vs Employer 80
    expect(rec.attestors[0].role).toBe('University');
    expect(rec.reasons['GAAA']).toContain('Degree');
  });

  it('boosts Licensing Body for credential type 2 (License)', () => {
    const pool: AttestorCandidate[] = [
      { address: 'GAAA', role: 'Licensing Body', reputationScore: 60, available: true },
      { address: 'GBBB', role: 'Employer', reputationScore: 85, available: true },
    ];
    const rec = recommendSlice(pool, 2, { credentialType: 2 })!;
    expect(rec.attestors[0].role).toBe('Licensing Body');
  });

  // ── industry context ────────────────────────────────────────────────────

  it('applies industry bonus for software industry (Employer top)', () => {
    const pool: AttestorCandidate[] = [
      { address: 'GAAA', role: 'Employer', reputationScore: 70, available: true },
      { address: 'GBBB', role: 'Licensing Body', reputationScore: 80, available: true },
    ];
    const rec = recommendSlice(pool, 2, { industry: 'software' })!;
    // Employer gets +25 in software → 95 vs Licensing Body 85
    expect(rec.attestors[0].role).toBe('Employer');
    expect(rec.reasons['GAAA']).toContain('software');
  });

  it('applies industry bonus for civil engineering (Licensing Body top)', () => {
    const pool: AttestorCandidate[] = [
      { address: 'GAAA', role: 'Licensing Body', reputationScore: 70, available: true },
      { address: 'GBBB', role: 'Employer', reputationScore: 80, available: true },
    ];
    const rec = recommendSlice(pool, 2, { industry: 'civil' })!;
    // Licensing Body gets +25 in civil → 95 vs Employer 90
    expect(rec.attestors[0].role).toBe('Licensing Body');
    expect(rec.reasons['GAAA']).toContain('civil');
  });

  // ── historical pattern context ──────────────────────────────────────────

  it('boosts historically used attestors', () => {
    const pool: AttestorCandidate[] = [
      { address: 'GAAA', role: 'Employer', reputationScore: 60, available: true },
      { address: 'GBBB', role: 'Employer', reputationScore: 70, available: true },
    ];
    const rec = recommendSlice(pool, 2, { history: { GAAA: 3 } })!;
    // GAAA gets +15 history bonus → 75 vs GBBB 70
    expect(rec.attestors[0].address).toBe('GAAA');
    expect(rec.reasons['GAAA']).toContain('3× previously');
  });

  it('caps history bonus at +20', () => {
    const pool: AttestorCandidate[] = [
      { address: 'GAAA', role: 'Employer', reputationScore: 50, available: true },
    ];
    const rec = recommendSlice(pool, 1, { history: { GAAA: 100 } })!;
    // capped at +20, no crash
    expect(rec.attestors[0].address).toBe('GAAA');
    expect(rec.reasons['GAAA']).toContain('previously');
  });

  // ── combined context ────────────────────────────────────────────────────

  it('applies all context signals together', () => {
    const pool: AttestorCandidate[] = [
      { address: 'GAAA', role: 'Licensing Body', reputationScore: 55, available: true },
      { address: 'GBBB', role: 'Employer', reputationScore: 90, available: true },
    ];
    // civil industry (+25 LicBody) + license type (+30 LicBody) + history on GAAA (+5)
    // GAAA: 55+25+30+5=115 vs GBBB: 90
    const rec = recommendSlice(pool, 2, {
      credentialType: 2,
      industry: 'civil',
      history: { GAAA: 1 },
    })!;
    expect(rec.attestors[0].address).toBe('GAAA');
  });
});

// ── SliceRecommendationPanel component ───────────────────────────────────────

describe('SliceRecommendationPanel (#947)', () => {
  it('shows empty state when no candidates', () => {
    render(<SliceRecommendationPanel candidates={[]} onAccept={vi.fn()} />);
    expect(screen.getByTestId('srp-empty')).toBeInTheDocument();
  });

  it('renders recommended attestors', () => {
    render(<SliceRecommendationPanel candidates={candidates} onAccept={vi.fn()} />);
    expect(screen.getByTestId('slice-recommendation-panel')).toBeInTheDocument();
    expect(screen.getByTestId('recommendation-score')).toBeInTheDocument();
    expect(screen.getByTestId('rec-threshold')).toBeInTheDocument();
  });

  it('shows accept button', () => {
    render(<SliceRecommendationPanel candidates={candidates} onAccept={vi.fn()} />);
    expect(screen.getByTestId('accept-recommendation')).toBeInTheDocument();
  });

  it('calls onAccept and shows accepted state when accepted', () => {
    const onAccept = vi.fn();
    render(<SliceRecommendationPanel candidates={candidates} onAccept={onAccept} />);
    fireEvent.click(screen.getByTestId('accept-recommendation'));
    expect(onAccept).toHaveBeenCalled();
    expect(screen.getByTestId('srp-accepted')).toBeInTheDocument();
  });

  it('allows removing an attestor to customize', () => {
    render(<SliceRecommendationPanel candidates={candidates} onAccept={vi.fn()} />);
    const removeButtons = screen.getAllByLabelText(/Remove .* from recommendation/i);
    const initialCount = screen.getAllByRole('listitem').length;
    fireEvent.click(removeButtons[0]);
    expect(screen.getAllByRole('listitem').length).toBe(initialCount - 1);
  });

  // ── context display ───────────────────────────────────────────────────────

  it('shows no context badges when context is empty', () => {
    render(<SliceRecommendationPanel candidates={candidates} onAccept={vi.fn()} />);
    expect(screen.queryByTestId('srp-context')).not.toBeInTheDocument();
  });

  it('shows credential type badge when credentialType is provided', () => {
    render(
      <SliceRecommendationPanel
        candidates={candidates}
        onAccept={vi.fn()}
        context={{ credentialType: 1 }}
      />
    );
    expect(screen.getByTestId('srp-badge-credtype')).toHaveTextContent('Degree');
  });

  it('shows industry badge when industry is provided', () => {
    render(
      <SliceRecommendationPanel
        candidates={candidates}
        onAccept={vi.fn()}
        context={{ industry: 'software' }}
      />
    );
    expect(screen.getByTestId('srp-badge-industry')).toHaveTextContent('software');
  });

  it('shows history badge when history is provided', () => {
    render(
      <SliceRecommendationPanel
        candidates={candidates}
        onAccept={vi.fn()}
        context={{ history: { [candidates[0].address]: 2 } }}
      />
    );
    expect(screen.getByTestId('srp-badge-history')).toBeInTheDocument();
  });

  it('renders per-attestor reason tags', () => {
    render(
      <SliceRecommendationPanel
        candidates={candidates}
        onAccept={vi.fn()}
        context={{ credentialType: 1 }}
      />
    );
    const reasonTags = screen.getAllByTestId(/^rec-reason-/);
    expect(reasonTags.length).toBeGreaterThan(0);
  });

  it('shows tailored description when context is provided', () => {
    render(
      <SliceRecommendationPanel
        candidates={candidates}
        onAccept={vi.fn()}
        context={{ credentialType: 2, industry: 'civil' }}
      />
    );
    expect(screen.getByText(/Tailored to your credential type/i)).toBeInTheDocument();
  });

  it('shows generic description when no context', () => {
    render(<SliceRecommendationPanel candidates={candidates} onAccept={vi.fn()} />);
    expect(screen.getByText(/Based on reputation and availability/i)).toBeInTheDocument();
  });
});
