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

describe('recommendSlice algorithm (#467)', () => {
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

  it('sorts available attestors by reputation descending', () => {
    const rec = recommendSlice(candidates, 3);
    const available = rec!.attestors.filter((a) => a.available);
    for (let i = 1; i < available.length; i++) {
      expect(available[i - 1].reputationScore).toBeGreaterThanOrEqual(available[i].reputationScore);
    }
  });

  it('sets threshold to ceil(n/2)', () => {
    expect(recommendSlice(candidates, 3)!.threshold).toBe(2); // ceil(3/2)
    expect(recommendSlice(candidates, 2)!.threshold).toBe(1); // ceil(2/2)
  });

  it('computes score as average reputation', () => {
    const rec = recommendSlice([candidates[0]], 1);
    expect(rec!.score).toBe(90);
  });
});

describe('SliceRecommendationPanel (#467)', () => {
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
});
