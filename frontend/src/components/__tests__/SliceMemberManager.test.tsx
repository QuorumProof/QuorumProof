import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SliceMemberManager, type SliceMember } from '../SliceMemberManager';

const VALID_ADDR = 'GW674PTN7IWEZ6AE6OWW3NBULKVCCJUZOGMUSG6HFG6ZOLSL56XCAMBX';

const mockMember: SliceMember = {
  id: 'member-1',
  address: 'GW674PTN7IWEZ6AE6OWW3NBULKVCCJUZOGMUSG6HFG6ZOLSL56XCAMBX',
  role: 'University',
  reputationScore: 85,
  available: true,
};

function renderManager(overrides: Partial<Parameters<typeof SliceMemberManager>[0]> = {}) {
  const props = {
    members: [],
    threshold: 1,
    onAddMember: vi.fn(),
    onRemoveMember: vi.fn(),
    onThresholdChange: vi.fn(),
    ...overrides,
  };
  render(<SliceMemberManager {...props} />);
  return props;
}

describe('SliceMemberManager (#465)', () => {
  it('renders the add attestor form', () => {
    renderManager();
    expect(screen.getByLabelText(/Stellar Address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Attestor role/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Reputation score/i)).toBeInTheDocument();
  });

  it('shows validation error for empty address', () => {
    render(<SliceMemberManager members={[]} threshold={1} onAddMember={vi.fn()} onRemoveMember={vi.fn()} onThresholdChange={vi.fn()} />);
    fireEvent.submit(screen.getByRole('form', { name: 'Add attestor form' }));
    expect(screen.getByText('Address is required.')).toBeInTheDocument();
  });

  it('shows validation error for invalid Stellar address', () => {
    render(<SliceMemberManager members={[]} threshold={1} onAddMember={vi.fn()} onRemoveMember={vi.fn()} onThresholdChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Stellar Address/i), { target: { value: 'invalid' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Add attestor form' }));
    expect(screen.getByText(/valid Stellar address/i)).toBeInTheDocument();
  });

  it('accepts valid Stellar address without showing error', () => {
    render(<SliceMemberManager members={[]} threshold={1} onAddMember={vi.fn()} onRemoveMember={vi.fn()} onThresholdChange={vi.fn()} />);
    const addrInput = screen.getByLabelText(/Stellar Address/i) as HTMLInputElement;
    fireEvent.change(addrInput, { target: { value: VALID_ADDR } });
    // Trigger validation by submitting
    fireEvent.submit(screen.getByRole('form', { name: 'Add attestor form' }));
    // No validation error should appear for a valid address
    expect(screen.queryByText(/valid Stellar address/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Address is required.')).not.toBeInTheDocument();
  });

  it('displays existing members with reputation scores', () => {
    renderManager({ members: [mockMember] });
    expect(screen.getByText(/GW674PTN/)).toBeInTheDocument();
    expect(screen.getAllByText('University').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/Reputation score 85/i)).toBeInTheDocument();
  });

  it('calls onRemoveMember when remove button clicked', () => {
    const { onRemoveMember } = renderManager({ members: [mockMember] });
    fireEvent.click(screen.getByLabelText(/Remove University/i));
    expect(onRemoveMember).toHaveBeenCalledWith('member-1');
  });

  it('shows threshold and required signatures', () => {
    renderManager({ members: [mockMember], threshold: 1 });
    expect(screen.getByTestId('threshold-display')).toHaveTextContent('1 / 1');
  });

  it('calls onThresholdChange when threshold input changes', () => {
    const onThresholdChange = vi.fn();
    render(<SliceMemberManager members={[mockMember, { ...mockMember, id: 'm2', address: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZQE3GGQMJYQMVAMLEGO' }]} threshold={1} onAddMember={vi.fn()} onRemoveMember={vi.fn()} onThresholdChange={onThresholdChange} />);
    const input = screen.getByLabelText(/Attestation threshold/i);
    fireEvent.change(input, { target: { value: '2' } });
    expect(onThresholdChange).toHaveBeenCalledWith(2);
  });

  it('shows empty state when no members', () => {
    renderManager();
    expect(screen.getByText(/No attestors added yet/i)).toBeInTheDocument();
  });
});
