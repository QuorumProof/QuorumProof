import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AttestorReputationPage from '../AttestorReputationPage';
import { useWallet } from '../../hooks';
import type { WalletState } from '../../context/WalletContextValue';

vi.mock('../../hooks', () => ({
  useWallet: vi.fn(),
}));

const ADDRESS = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNQB37HNU7F5V4Z5SHEOSVBQ';

function createWalletState(address: string | null): WalletState {
  return {
    address,
    wallets: address ? [address] : [],
    walletType: address ? 'freighter' : null,
    accountIndex: 0,
    activeIndex: 0,
    isConnected: Boolean(address),
    hasFreighter: Boolean(address),
    isInitializing: false,
    network: 'testnet',
    error: null,
    availableWallets: address ? ['freighter'] : [],
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    switchWallet: vi.fn(),
    setAccountIndexForWallet: vi.fn(),
  };
}

const emptyReputation = {
  address: ADDRESS,
  score: 0,
  attestation_count: 0,
  total_activity: 0,
  success_rate: null,
  period_days: 30,
};

describe('AttestorReputationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useWallet).mockReturnValue(createWalletState(ADDRESS));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prompts for a wallet without requesting reputation data when disconnected', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(useWallet).mockReturnValue(createWalletState(null));

    render(<AttestorReputationPage />);

    expect(screen.getByText('Connect your wallet to view your attestor reputation.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the empty reputation metrics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(emptyReputation)),
    ));

    render(<AttestorReputationPage />);

    expect(await screen.findByText('Inactive')).toBeInTheDocument();
    expect(screen.getByText('N/A')).toBeInTheDocument();
    expect(screen.getByText('of 0 events')).toBeInTheDocument();
  });

  it('shows a loading state while the reputation request is pending', async () => {
    let finishRequest: (response: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        finishRequest = resolve;
      }),
    ));

    render(<AttestorReputationPage />);

    await waitFor(() => expect(document.querySelector('.animate-pulse')).not.toBeNull());
    finishRequest(new Response(JSON.stringify(emptyReputation)));
    await waitFor(() => expect(screen.getByText('Inactive')).toBeInTheDocument());
  });

  it('shows the request error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Reputation unavailable')));

    render(<AttestorReputationPage />);

    expect(await screen.findByText('Reputation unavailable')).toBeInTheDocument();
  });
});
