/**
 * AttestationProgress.test.tsx — issue #468
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AttestationProgress, estimateCompletion } from '../../components/AttestationProgress';
import type { QuorumSlice } from '../../lib/contracts/quorumProof';

const ADDR_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN';
const ADDR_B = 'GBAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN';
const ADDR_C = 'GCAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN';

const mockSlice: QuorumSlice = {
  id: 1n,
  creator: ADDR_A,
  attestors: [ADDR_A, ADDR_B, ADDR_C],
  threshold: 2,
};

describe('estimateCompletion', () => {
  it('returns Complete when no pending', () => {
    expect(estimateCompletion(0)).toBe('Complete');
  });

  it('returns hours for 1 pending', () => {
    expect(estimateCompletion(1)).toBe('~24h');
  });

  it('returns days for 3+ pending', () => {
    expect(estimateCompletion(3)).toBe('~3 days');
  });
});

describe('AttestationProgress', () => {
  it('renders progress bar with correct aria attributes', () => {
    render(<AttestationProgress attestors={[ADDR_A]} slice={mockSlice} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '2');
  });

  it('shows signed attestors with Signed label', () => {
    render(<AttestationProgress attestors={[ADDR_A]} slice={mockSlice} />);
    const items = screen.getAllByRole('status');
    const signed = items.filter((el) => el.textContent === 'Signed');
    expect(signed.length).toBeGreaterThanOrEqual(1);
  });

  it('shows pending attestors with Pending label', () => {
    render(<AttestationProgress attestors={[ADDR_A]} slice={mockSlice} />);
    const items = screen.getAllByRole('status');
    const pending = items.filter((el) => el.textContent === 'Pending');
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  it('shows ETA when not complete', () => {
    render(<AttestationProgress attestors={[ADDR_A]} slice={mockSlice} />);
    expect(screen.getByTestId('eta')).toBeInTheDocument();
  });

  it('hides ETA when fully attested', () => {
    render(<AttestationProgress attestors={[ADDR_A, ADDR_B]} slice={mockSlice} />);
    expect(screen.queryByTestId('eta')).not.toBeInTheDocument();
  });

  it('renders without slice (attestors only)', () => {
    render(<AttestationProgress attestors={[ADDR_A, ADDR_B]} slice={null} />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});
