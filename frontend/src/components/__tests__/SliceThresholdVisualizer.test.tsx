import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SliceThresholdVisualizer, getSliceHealth } from '../SliceThresholdVisualizer';

describe('getSliceHealth (#466)', () => {
  it('returns healthy when available >= threshold', () => {
    expect(getSliceHealth(3, 3)).toBe('healthy');
    expect(getSliceHealth(5, 3)).toBe('healthy');
  });

  it('returns degraded when available > 0 but < threshold', () => {
    expect(getSliceHealth(1, 3)).toBe('degraded');
    expect(getSliceHealth(2, 3)).toBe('degraded');
  });

  it('returns critical when no attestors available', () => {
    expect(getSliceHealth(0, 3)).toBe('critical');
  });
});

describe('SliceThresholdVisualizer (#466)', () => {
  it('renders progress bar with correct aria attributes', () => {
    render(<SliceThresholdVisualizer attestations={2} threshold={3} totalAttestors={4} availableAttestors={4} />);
    const bar = screen.getByRole('progressbar', { name: /Attestation progress/i });
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(bar).toHaveAttribute('aria-valuemax', '3');
  });

  it('shows attestation count', () => {
    render(<SliceThresholdVisualizer attestations={1} threshold={3} totalAttestors={3} availableAttestors={3} />);
    expect(screen.getByTestId('attestation-count')).toHaveTextContent('1 / 3 required');
  });

  it('shows healthy indicator when all attestors available', () => {
    render(<SliceThresholdVisualizer attestations={3} threshold={3} totalAttestors={3} availableAttestors={3} />);
    const indicator = screen.getByTestId('health-indicator');
    expect(indicator).toHaveAttribute('data-health', 'healthy');
    expect(indicator).toHaveTextContent(/All attestors available/i);
  });

  it('shows degraded indicator when some attestors unavailable', () => {
    render(<SliceThresholdVisualizer attestations={1} threshold={3} totalAttestors={3} availableAttestors={1} />);
    const indicator = screen.getByTestId('health-indicator');
    expect(indicator).toHaveAttribute('data-health', 'degraded');
    expect(indicator).toHaveTextContent(/Some attestors unavailable/i);
  });

  it('shows critical indicator when no attestors available', () => {
    render(<SliceThresholdVisualizer attestations={0} threshold={3} totalAttestors={3} availableAttestors={0} />);
    const indicator = screen.getByTestId('health-indicator');
    expect(indicator).toHaveAttribute('data-health', 'critical');
    expect(indicator).toHaveTextContent(/No attestors available/i);
  });

  it('caps progress at 100% when attestations exceed threshold', () => {
    render(<SliceThresholdVisualizer attestations={5} threshold={3} totalAttestors={5} availableAttestors={5} />);
    const fill = screen.getByTestId('progress-fill');
    expect(fill).toHaveStyle({ width: '100%' });
  });

  it('shows 0% progress when no attestations', () => {
    render(<SliceThresholdVisualizer attestations={0} threshold={3} totalAttestors={3} availableAttestors={3} />);
    const fill = screen.getByTestId('progress-fill');
    expect(fill).toHaveStyle({ width: '0%' });
  });
});
