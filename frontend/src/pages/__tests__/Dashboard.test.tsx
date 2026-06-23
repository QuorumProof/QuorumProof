import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Dashboard from '../Dashboard';
import { useWallet, useRealtimeUpdates } from '../../hooks';
import { getCredentialsBySubject } from '../../stellar';

vi.mock('../../hooks', () => ({
  useWallet: vi.fn(),
  useRealtimeUpdates: vi.fn(() => ({ status: 'polling', reconnect: vi.fn() })),
}));

vi.mock('../../stellar', () => ({
  getCredentialsBySubject: vi.fn(),
  getCredential: vi.fn(),
  isAttested: vi.fn(),
  getAttestors: vi.fn(),
  getSlice: vi.fn(),
  isExpired: vi.fn(),
  decodeMetadataHash: vi.fn(() => 'test-hash'),
}));

vi.mock('../../components/Navbar', () => ({ Navbar: () => <div>Navbar</div> }));
vi.mock('../../components/WalletGate', () => ({ WalletGate: () => <div>WalletGate</div> }));
vi.mock('../../components/CredentialCard', () => ({ CredentialCard: () => <div>CredentialCard</div> }));
vi.mock('../../components/CredentialCardSkeleton', () => ({
  CredentialCardSkeleton: () => <div data-testid="credential-skeleton">Skeleton</div>,
}));
vi.mock('../../components/EmptyState', () => ({ EmptyState: () => <div>EmptyState</div> }));

const TEST_ADDR = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNQB37HNU7F5V4Z5SHEOSVBQ';

const walletConnected = {
  address: TEST_ADDR,
  hasFreighter: true,
  isInitializing: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
};

describe('Dashboard (#239)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(useRealtimeUpdates).mockReturnValue({ status: 'polling', reconnect: vi.fn() });
  });

  it('renders skeleton cards while loading credentials', async () => {
    vi.mocked(useWallet).mockReturnValue(walletConnected as any);
    vi.mocked(getCredentialsBySubject).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 100))
    );

    render(<BrowserRouter><Dashboard /></BrowserRouter>);

    expect(screen.getAllByTestId('credential-skeleton')).toHaveLength(3);
    await waitFor(() => expect(getCredentialsBySubject).toHaveBeenCalledWith(TEST_ADDR));
  });

  it('clears skeletons once data resolves', async () => {
    vi.mocked(useWallet).mockReturnValue(walletConnected as any);
    vi.mocked(getCredentialsBySubject).mockResolvedValue([]);

    render(<BrowserRouter><Dashboard /></BrowserRouter>);

    await waitFor(() => {
      expect(screen.queryAllByTestId('credential-skeleton')).toHaveLength(0);
    });
  });

  it('shows empty state when no credentials exist', async () => {
    vi.mocked(useWallet).mockReturnValue(walletConnected as any);
    vi.mocked(getCredentialsBySubject).mockResolvedValue([]);

    render(<BrowserRouter><Dashboard /></BrowserRouter>);

    await waitFor(() => expect(screen.getByText('EmptyState')).toBeInTheDocument());
  });

  it('does not show skeletons when wallet is not connected', () => {
    vi.mocked(useWallet).mockReturnValue({ address: null, hasFreighter: true, isInitializing: false, connect: vi.fn(), disconnect: vi.fn() } as any);

    render(<BrowserRouter><Dashboard /></BrowserRouter>);

    expect(screen.queryAllByTestId('credential-skeleton')).toHaveLength(0);
  });
});
