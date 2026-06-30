/**
 * SliceSimulator.test.tsx
 * Tests for slice simulation/preview mode — issue #946.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import type { AttestorEntry } from '../lib/sliceBuilderUtils';
import {
  signedWeight,
  evaluateScenario,
  scenarioStats,
  faultTolerance,
  minimalWinningCoalitions,
} from '../lib/sliceSimulator';
import { SliceSimulator } from '../components/SliceSimulator';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function attestor(id: string, weight: number, role = 'University'): AttestorEntry {
  return { id, address: `G${id.toUpperCase().padEnd(55, 'A')}`, role, weight };
}

const TWO_EQUAL: AttestorEntry[] = [attestor('a', 2), attestor('b', 2)];

// ── Pure logic ────────────────────────────────────────────────────────────────

describe('signedWeight', () => {
  it('sums only the signing attestors', () => {
    expect(signedWeight(TWO_EQUAL, new Set(['a']))).toBe(2);
    expect(signedWeight(TWO_EQUAL, new Set(['a', 'b']))).toBe(4);
    expect(signedWeight(TWO_EQUAL, new Set())).toBe(0);
  });
});

describe('evaluateScenario', () => {
  it('reports success with surplus when threshold met', () => {
    const r = evaluateScenario(TWO_EQUAL, 3, new Set(['a', 'b']));
    expect(r.success).toBe(true);
    expect(r.signedWeight).toBe(4);
    expect(r.surplus).toBe(1);
    expect(r.deficit).toBe(0);
  });

  it('reports failure with deficit when threshold unmet', () => {
    const r = evaluateScenario(TWO_EQUAL, 3, new Set(['a']));
    expect(r.success).toBe(false);
    expect(r.deficit).toBe(1);
    expect(r.surplus).toBe(0);
    expect(r.percentOfThreshold).toBe(67);
  });

  it('treats an empty slice as failure', () => {
    expect(evaluateScenario([], 1, new Set()).success).toBe(false);
  });
});

describe('scenarioStats', () => {
  it('counts winning subsets across all combinations', () => {
    // subsets of {2,2} vs threshold 3: only {a,b}=4 wins.
    const s = scenarioStats(TWO_EQUAL, 3);
    expect(s.enumerated).toBe(true);
    expect(s.totalScenarios).toBe(4);
    expect(s.winningScenarios).toBe(1);
    expect(s.winRatePct).toBe(25);
  });

  it('flags configurations too large to enumerate', () => {
    const many = Array.from({ length: 17 }, (_, i) => attestor(`n${i}`, 1));
    expect(scenarioStats(many, 5).enumerated).toBe(false);
  });
});

describe('faultTolerance', () => {
  it('is zero when losing any top-weight attestor breaks consensus', () => {
    // weights [3,3,2,1] tw=9, threshold 7 → 9-3=6 < 7, none can drop.
    const a = [attestor('a', 3), attestor('b', 3), attestor('c', 2), attestor('d', 1)];
    expect(faultTolerance(a, 7)).toBe(0);
  });

  it('counts how many top-weight attestors can drop', () => {
    // tw=9, threshold 5 → drop a 3 (remaining 6 >=5), then 6-3=3 < 5 stop → 1.
    const a = [attestor('a', 3), attestor('b', 3), attestor('c', 2), attestor('d', 1)];
    expect(faultTolerance(a, 5)).toBe(1);
  });

  it('is zero for an unreachable threshold', () => {
    expect(faultTolerance(TWO_EQUAL, 99)).toBe(0);
  });
});

describe('minimalWinningCoalitions', () => {
  it('returns just-sufficient signer sets', () => {
    const c = minimalWinningCoalitions(TWO_EQUAL, 3);
    expect(c).toHaveLength(1);
    expect(c[0].map((a) => a.id).sort()).toEqual(['a', 'b']);
  });

  it('returns nothing for an unreachable threshold', () => {
    expect(minimalWinningCoalitions(TWO_EQUAL, 99)).toEqual([]);
  });
});

// ── Component ─────────────────────────────────────────────────────────────────

describe('<SliceSimulator />', () => {
  it('prompts when there are no attestors', () => {
    render(<SliceSimulator attestors={[]} threshold={1} />);
    expect(screen.getByText(/add attestors to simulate/i)).toBeInTheDocument();
  });

  it('shows consensus reached when everyone signs and the threshold is reachable', () => {
    render(<SliceSimulator attestors={TWO_EQUAL} threshold={3} />);
    expect(screen.getByText(/consensus reached/i)).toBeInTheDocument();
  });

  it('flips to not reached when no one signs', () => {
    render(<SliceSimulator attestors={TWO_EQUAL} threshold={3} />);
    fireEvent.click(screen.getByRole('button', { name: /none sign/i }));
    expect(screen.getByText(/consensus not reached/i)).toBeInTheDocument();
  });

  it('updates the outcome when an attestor is toggled off', () => {
    render(<SliceSimulator attestors={TWO_EQUAL} threshold={3} />);
    expect(screen.getByText(/consensus reached/i)).toBeInTheDocument();
    // Untick the first attestor: signed weight drops to 2 < 3.
    const list = screen.getByLabelText(/toggle which attestors sign/i);
    const firstCheckbox = within(list).getAllByRole('checkbox')[0];
    fireEvent.click(firstCheckbox);
    expect(screen.getByText(/consensus not reached/i)).toBeInTheDocument();
  });

  it('"Minimum to pass" selects a sufficient signer set', () => {
    render(<SliceSimulator attestors={TWO_EQUAL} threshold={3} />);
    fireEvent.click(screen.getByRole('button', { name: /none sign/i }));
    expect(screen.getByText(/consensus not reached/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /minimum to pass/i }));
    expect(screen.getByText(/consensus reached/i)).toBeInTheDocument();
  });
});
