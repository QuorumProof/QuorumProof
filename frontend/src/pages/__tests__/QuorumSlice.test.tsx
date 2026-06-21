import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import QuorumSlice from '../QuorumSlice';
import { useWallet } from '../../hooks';

vi.mock('../../hooks', () => ({
  useWallet: vi.fn(),
}));

vi.mock('../../components/QuorumSliceBuilder', () => ({
  QuorumSliceBuilder: ({ creatorAddress }: { creatorAddress: string }) => (
    <div data-testid="quorum-slice-builder" data-creator-address={creatorAddress}>
      QuorumSliceBuilder
    </div>
  ),
}));

vi.mock('../../components/SliceBackupRestore', () => ({
  SliceBackupRestore: () => <div>SliceBackupRestore</div>,
}));

describe('QuorumSlice page (#236)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('passes creatorAddress from wallet to QuorumSliceBuilder', () => {
    const testAddress = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNQB37HNU7F5V4Z5SHEOSVBQ';

    vi.mocked(useWallet).mockReturnValue({
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
});
