import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { WalletProvider, useWallet } from '../WalletContext';
import * as walletKit from '../../lib/wallet/wallet-kit';

vi.mock('../../lib/wallet/wallet-kit', () => ({
  initWalletKit: vi.fn(),
  listSupportedWallets: vi.fn().mockResolvedValue([]),
  getConnectedAddress: vi.fn(),
  connectWithWallet: vi.fn(),
  disconnectWalletKit: vi.fn(),
  signWalletTransaction: vi.fn(),
  onWalletKitDisconnect: vi.fn(() => () => {}),
  onWalletKitStateUpdated: vi.fn(() => () => {}),
  formatWalletError: (e: unknown) => (e instanceof Error ? e.message : 'Wallet request failed'),
  WALLET_STORAGE_KEY: 'quorum-proof-wallet-address',
  WALLET_ID_STORAGE_KEY: 'quorum-proof-wallet-id',
}));

vi.mock('../../lib/wallet/balance', () => ({
  getNativeXlmBalance: vi.fn().mockResolvedValue(0n),
  getXlmUsdPrice: vi.fn().mockResolvedValue(null),
  formatXlmBalance: vi.fn(() => '0 XLM'),
  xlmToUsd: vi.fn(() => '$0.00'),
}));

const TestComponent = () => {
  const { address, isConnected, error, disconnect } = useWallet();
  return (
    <div>
      <div data-testid="address">{address || 'Not connected'}</div>
      <div data-testid="is-connected">{isConnected ? 'Connected' : 'Disconnected'}</div>
      <div data-testid="error">{error || 'No error'}</div>
      <button onClick={disconnect}>Disconnect</button>
    </div>
  );
};

describe('WalletContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('restores an active wallet session and persists address', async () => {
    vi.mocked(walletKit.getConnectedAddress).mockResolvedValue('GTEST123');

    render(
      <WalletProvider>
        <TestComponent />
      </WalletProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('address')).toHaveTextContent('GTEST123');
    });
    expect(localStorage.getItem('quorum-proof-wallet-address')).toBe('GTEST123');
  });

  it('disconnect clears persisted address and error state', async () => {
    localStorage.setItem('quorum-proof-wallet-address', 'GTEST123');
    vi.mocked(walletKit.getConnectedAddress).mockResolvedValue('GTEST123');

    render(
      <WalletProvider>
        <TestComponent />
      </WalletProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('address')).toHaveTextContent('GTEST123');
    });

    screen.getByText('Disconnect').click();

    await waitFor(() => {
      expect(screen.getByTestId('is-connected')).toHaveTextContent('Disconnected');
      expect(screen.getByTestId('error')).toHaveTextContent('No error');
      expect(localStorage.getItem('quorum-proof-wallet-address')).toBeNull();
    });
  });
});
