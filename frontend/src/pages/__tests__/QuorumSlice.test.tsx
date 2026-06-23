import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import QuorumSlice from '../QuorumSlice';
import { useWallet } from '../../hooks';

vi.mock('../../hooks', () => ({
  useWallet: vi.fn(),
}));

vi.mock('../../components/QuorumSliceBuilder', () => ({
  QuorumSliceBuilder: ({
    creatorAddress,
    initialThreshold,
  }: {
    creatorAddress: string;
    initialThreshold?: number;
  }) => (
    <div
      data-testid="quorum-slice-builder"
      data-creator-address={creatorAddress}
      data-initial-threshold={initialThreshold ?? ''}
    >
      QuorumSliceBuilder
    </div>
  ),
}));

vi.mock('../../components/SliceBackupRestore', () => ({
  SliceBackupRestore: () => <div>SliceBackupRestore</div>,
}));

const mockUseWallet = vi.mocked(useWallet);

describe('QuorumSlice page (#236)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('passes creatorAddress from wallet to QuorumSliceBuilder', () => {
    const testAddress = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNQB37HNU7F5V4Z5SHEOSVBQ';

    mockUseWallet.mockReturnValue({
      address: testAddress,
      isInitializing: false,
    } as ReturnType<typeof useWallet>);

    render(
      <BrowserRouter>
        <QuorumSlice />
      </BrowserRouter>
    );

    const builder = screen.getByTestId('quorum-slice-builder');
    expect(builder).toHaveAttribute('data-creator-address', testAddress);
  });

  it('loads slice configuration from URL search params', () => {
    const testAddress = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNQB37HNU7F5V4Z5SHEOSVBQ';
    const draft = { attestors: [], threshold: 3 };
    const encoded = btoa(JSON.stringify(draft));

    mockUseWallet.mockReturnValue({
      address: testAddress,
      isInitializing: false,
    } as ReturnType<typeof useWallet>);

    render(
      <MemoryRouter initialEntries={[`/slice/new?slice=${encoded}`]}>
        <QuorumSlice />
      </MemoryRouter>
    );

    expect(screen.getByText(/Slice configuration loaded from shared URL/)).toBeInTheDocument();
    const builder = screen.getByTestId('quorum-slice-builder');
    expect(builder).toHaveAttribute('data-initial-threshold', '3');
  });

  it('renders SliceBackupRestore section', () => {
    mockUseWallet.mockReturnValue({
      address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNQB37HNU7F5V4Z5SHEOSVBQ',
      isInitializing: false,
    } as ReturnType<typeof useWallet>);

    render(
      <BrowserRouter>
        <QuorumSlice />
      </BrowserRouter>
    );

    expect(screen.getByText('SliceBackupRestore')).toBeInTheDocument();
  });
});
