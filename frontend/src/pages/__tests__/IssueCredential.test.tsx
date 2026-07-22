import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import IssueCredential from '../IssueCredential';
import { useFreighter } from '../../lib/hooks/useFreighter';

// Mock useFreighter hook
vi.mock('../../lib/hooks/useFreighter', () => ({
  useFreighter: vi.fn(),
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

    vi.mocked(useFreighter).mockReturnValue({
      address: testAddress,
      isInitializing: false,
      connect: vi.fn(),
      hasFreighter: true,
      disconnect: vi.fn(),
    });

    render(
      <BrowserRouter>
        <IssueCredential />
      </BrowserRouter>
    );

    const form = screen.getByTestId('issue-credential-form');
    expect(form).toHaveAttribute('data-issuer-address', testAddress);
  });

  it('shows connect wallet prompt when no address is available', () => {
    vi.mocked(useFreighter).mockReturnValue({
      address: null,
      isInitializing: false,
      connect: vi.fn(),
      hasFreighter: true,
      disconnect: vi.fn(),
    });

    render(
      <BrowserRouter>
        <IssueCredential />
      </BrowserRouter>
    );

    expect(screen.getByText('Connect Your Wallet')).toBeInTheDocument();
    expect(screen.getByText(/You must connect a Freighter wallet/)).toBeInTheDocument();
  });

  it('shows loading state while wallet is initializing', () => {
    vi.mocked(useFreighter).mockReturnValue({
      address: null,
      isInitializing: true,
      connect: vi.fn(),
      hasFreighter: true,
      disconnect: vi.fn(),
    });

    render(
      <BrowserRouter>
        <IssueCredential />
      </BrowserRouter>
    );

    expect(screen.getByText('Connecting wallet…')).toBeInTheDocument();
  });

  it('does not render IssueCredentialForm when address is undefined', () => {
    vi.mocked(useFreighter).mockReturnValue({
      address: undefined,
      isInitializing: false,
      connect: vi.fn(),
      hasFreighter: true,
      disconnect: vi.fn(),
    });

    render(
      <BrowserRouter>
        <IssueCredential />
      </BrowserRouter>
    );

    expect(screen.queryByTestId('issue-credential-form')).not.toBeInTheDocument();
  });

  it('renders wallet gate with proper accessibility attributes', () => {
    vi.mocked(useFreighter).mockReturnValue({
      address: null,
      isInitializing: false,
      connect: vi.fn(),
      hasFreighter: true,
      disconnect: vi.fn(),
    });

    render(
      <BrowserRouter>
        <IssueCredential />
      </BrowserRouter>
    );

    const walletGate = screen.getByRole('region', { name: /Wallet connection required/ });
    expect(walletGate).toBeInTheDocument();
  });
});
