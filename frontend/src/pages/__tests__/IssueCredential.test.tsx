import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import IssueCredential from '../IssueCredential';
import { useWallet } from '../../hooks';
import type { WalletState } from '../../context/WalletContextValue';

// Mock useWallet hook (IssueCredential is gated by <WalletGuard>, which reads
// address/isInitializing/availableWallets/connect from this hook)
vi.mock('../../hooks', () => ({
  useWallet: vi.fn(),
}));

// Mock IssueCredentialForm component
vi.mock('../../components/IssueCredentialForm', () => ({
  IssueCredentialForm: ({ issuerAddress }: { issuerAddress: string }) => (
    <div data-testid="issue-credential-form" data-issuer-address={issuerAddress}>
      IssueCredentialForm
    </div>
  ),
}));

// Mock Navbar
vi.mock('../../components/Navbar', () => ({
  Navbar: () => <div>Navbar</div>,
}));

describe('IssueCredential page (#237)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes issuerAddress from wallet to IssueCredentialForm', () => {
    const testAddress = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNQB37HNU7F5V4Z5SHEOSVBQ';

    vi.mocked(useWallet).mockReturnValue({
      address: testAddress,
      isInitializing: false,
      availableWallets: ['freighter'],
      connect: vi.fn(),
      hasFreighter: true,
      disconnect: vi.fn(),
    } as unknown as WalletState);

    render(
      <BrowserRouter>
        <IssueCredential />
      </BrowserRouter>
    );

    const form = screen.getByTestId('issue-credential-form');
    expect(form).toHaveAttribute('data-issuer-address', testAddress);
  });

  it('shows connect wallet prompt when no address is available', () => {
    vi.mocked(useWallet).mockReturnValue({
      address: null,
      isInitializing: false,
      availableWallets: ['freighter'],
      connect: vi.fn(),
      hasFreighter: true,
      disconnect: vi.fn(),
    } as unknown as WalletState);

    render(
      <BrowserRouter>
        <IssueCredential />
      </BrowserRouter>
    );

    expect(screen.getByText('Connect your Stellar wallet to continue')).toBeInTheDocument();
    expect(screen.getByText(/Select a wallet to connect/)).toBeInTheDocument();
  });

  it('shows loading state while wallet is initializing', () => {
    vi.mocked(useWallet).mockReturnValue({
      address: null,
      isInitializing: true,
      availableWallets: [],
      connect: vi.fn(),
      hasFreighter: true,
      disconnect: vi.fn(),
    } as unknown as WalletState);

    render(
      <BrowserRouter>
        <IssueCredential />
      </BrowserRouter>
    );

    expect(screen.getByText('Checking wallet…')).toBeInTheDocument();
  });

  it('does not render IssueCredentialForm when address is undefined', () => {
    vi.mocked(useWallet).mockReturnValue({
      address: undefined,
      isInitializing: false,
      availableWallets: ['freighter'],
      connect: vi.fn(),
      hasFreighter: true,
      disconnect: vi.fn(),
    } as unknown as WalletState);

    render(
      <BrowserRouter>
        <IssueCredential />
      </BrowserRouter>
    );

    expect(screen.queryByTestId('issue-credential-form')).not.toBeInTheDocument();
  });

  it('renders wallet gate with proper accessibility attributes', () => {
    vi.mocked(useWallet).mockReturnValue({
      address: null,
      isInitializing: false,
      availableWallets: ['freighter'],
      connect: vi.fn(),
      hasFreighter: true,
      disconnect: vi.fn(),
    } as unknown as WalletState);

    render(
      <BrowserRouter>
        <IssueCredential />
      </BrowserRouter>
    );

    const walletGate = screen.getByRole('region', { name: /Wallet connection required/ });
    expect(walletGate).toBeInTheDocument();
  });
});
