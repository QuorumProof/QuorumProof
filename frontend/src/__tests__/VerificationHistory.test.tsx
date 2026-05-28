/**
 * VerificationHistory.test.tsx
 * Tests for the verification history UI — issue #verification-history
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { VerificationHistory } from '../components/VerificationHistory';
import type { VerificationRecord } from '../components/VerificationHistory';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADDR_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN';
const ADDR_B = 'GBAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN';

const NOW_S = BigInt(Math.floor(Date.now() / 1000));
const ONE_HOUR = 3600n;

function makeRecord(
  id: number,
  verifier: string,
  requested_at: bigint,
  claim_types: string[] = [],
): VerificationRecord {
  return { id: BigInt(id), verifier, requested_at, claim_types };
}

const RECORDS: VerificationRecord[] = [
  makeRecord(1, ADDR_A, NOW_S - ONE_HOUR * 2n, ['HasDegree']),
  makeRecord(2, ADDR_B, NOW_S - ONE_HOUR * 48n, ['HasLicense']),
  makeRecord(3, ADDR_A, NOW_S - ONE_HOUR * 200n, []),
];

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('VerificationHistory — rendering', () => {
  it('renders the verification history container', () => {
    render(<VerificationHistory records={RECORDS} />);
    expect(screen.getByLabelText('Verification history')).toBeInTheDocument();
  });

  it('shows the total count', () => {
    render(<VerificationHistory records={RECORDS} />);
    expect(screen.getByText(/3 verifications/i)).toBeInTheDocument();
  });

  it('renders one row per record', () => {
    render(<VerificationHistory records={RECORDS} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
  });

  it('shows truncated verifier address', () => {
    render(<VerificationHistory records={[RECORDS[0]]} />);
    expect(screen.getByText(new RegExp(ADDR_A.slice(0, 8)))).toBeInTheDocument();
  });

  it('shows claim types as access type', () => {
    render(<VerificationHistory records={[RECORDS[0]]} />);
    expect(screen.getByText('HasDegree')).toBeInTheDocument();
  });

  it('shows "Full view" when claim_types is empty', () => {
    render(<VerificationHistory records={[RECORDS[2]]} />);
    expect(screen.getByText('Full view')).toBeInTheDocument();
  });

  it('shows empty state when no records', () => {
    render(<VerificationHistory records={[]} />);
    expect(screen.getByText(/no verifications/i)).toBeInTheDocument();
  });

  it('renders the time filter selector', () => {
    render(<VerificationHistory records={RECORDS} />);
    expect(screen.getByLabelText('Filter verifications by time')).toBeInTheDocument();
  });
});

// ── Sorting ───────────────────────────────────────────────────────────────────

describe('VerificationHistory — sorting', () => {
  it('shows most recent verification first', () => {
    render(<VerificationHistory records={RECORDS} />);
    const items = screen.getAllByRole('listitem');
    // Record 1 is most recent (NOW - 2h), should be first
    expect(items[0]).toHaveAttribute('data-testid', 'verification-record-1');
  });
});

// ── Filter ────────────────────────────────────────────────────────────────────

describe('VerificationHistory — time filter', () => {
  it('defaults to "All time" showing all records', () => {
    render(<VerificationHistory records={RECORDS} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('filters to last 24 hours', async () => {
    render(<VerificationHistory records={RECORDS} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter verifications by time'), {
        target: { value: '24' },
      });
    });
    // Only record 1 (NOW - 2h) is within 24h
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByTestId('verification-record-1')).toBeInTheDocument();
  });

  it('filters to last 7 days', async () => {
    render(<VerificationHistory records={RECORDS} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter verifications by time'), {
        target: { value: '168' },
      });
    });
    // Records 1 (2h ago) and 2 (48h ago) are within 7 days
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows empty state when filter excludes all records', async () => {
    render(<VerificationHistory records={RECORDS} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter verifications by time'), {
        target: { value: '1' },
      });
    });
    expect(screen.getByText(/no verifications in this period/i)).toBeInTheDocument();
  });

  it('shows correct count after filtering', async () => {
    render(<VerificationHistory records={RECORDS} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter verifications by time'), {
        target: { value: '168' },
      });
    });
    expect(screen.getByText(/2 verifications/i)).toBeInTheDocument();
  });

  it('restoring "All time" shows all records again', async () => {
    render(<VerificationHistory records={RECORDS} />);
    const select = screen.getByLabelText('Filter verifications by time');
    await act(async () => { fireEvent.change(select, { target: { value: '24' } }); });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    await act(async () => { fireEvent.change(select, { target: { value: '0' } }); });
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});

// ── Multiple claim types ──────────────────────────────────────────────────────

describe('VerificationHistory — access type display', () => {
  it('joins multiple claim types with comma', () => {
    const rec = makeRecord(10, ADDR_A, NOW_S, ['HasDegree', 'HasLicense']);
    render(<VerificationHistory records={[rec]} />);
    expect(screen.getByText('HasDegree, HasLicense')).toBeInTheDocument();
  });
});
