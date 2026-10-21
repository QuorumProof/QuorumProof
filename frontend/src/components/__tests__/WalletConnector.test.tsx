import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WalletConnector } from '../WalletConnector';
import { useWallet } from '../../context/WalletContextValue';
import type { WalletState } from '../../context/WalletContextValue';

vi.mock('../../context/WalletContextValue', () => ({
  useWallet: vi.fn(),
}));

vi.mock('../../wallets/registry', () => ({
  getAllWalletAdapters: () => [
    { type: 'freighter', name: 'Freighter', icon: '🦊' },
    { type: 'ledger', name: 'Ledger', icon: '💻' },
    { type: 'trezor', name: 'Trezor', icon: '🔒' },
  ],
}));

const createWalletState = (overrides: Partial<WalletState> = {}): WalletState => ({
  address: null,
  wallets: [],
  walletType: null,
  accountIndex: 0,
  activeIndex: 0,
  isConnected: false,
  hasFreighter: true,
  isInitializing: false,
  network: 'testnet',
  error: null,
  availableWallets: ['freighter', 'ledger', 'trezor'],
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  switchWallet: vi.fn(),
  setAccountIndexForWallet: vi.fn(),
  ...overrides,
});

describe('WalletConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useWallet).mockReturnValue(createWalletState());
  });

  it('connects to the selected software wallet', () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useWallet).mockReturnValue(createWalletState({ connect }));

    render(<WalletConnector />);
    fireEvent.click(screen.getByRole('button', { name: /Freighter/i }));

    expect(connect).toHaveBeenCalledWith('freighter');
  });

  it('connects to a selected hardware wallet account', () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useWallet).mockReturnValue(createWalletState({ connect }));

    render(<WalletConnector />);
    fireEvent.click(screen.getByRole('button', { name: /Ledger/i }));
    fireEvent.change(screen.getByLabelText('Hardware wallet account index'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(connect).toHaveBeenCalledWith('ledger', 3);
  });

  it('disconnects the active wallet', () => {
    const disconnect = vi.fn();
    vi.mocked(useWallet).mockReturnValue(createWalletState({
      address: 'GTEST',
      walletType: 'freighter',
      disconnect,
    }));

    render(<WalletConnector />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('shows an install prompt when no wallet extension is available', () => {
    vi.mocked(useWallet).mockReturnValue(createWalletState({
      hasFreighter: false,
      availableWallets: [],
    }));

    render(<WalletConnector />);

    expect(screen.getByText(/No wallet detected/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Install Freighter' })).toHaveAttribute(
      'href',
      'https://freighter.app',
    );
  });

  it('shows the wallet connection error and allows retry', () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useWallet).mockReturnValue(createWalletState({
      error: 'Wallet extension unavailable',
      connect,
    }));

    render(<WalletConnector />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(screen.getByText('Wallet extension unavailable')).toBeInTheDocument();
    expect(connect).toHaveBeenCalledWith();
  });
});
