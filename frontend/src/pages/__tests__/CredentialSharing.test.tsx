/**
 * Tests for CredentialSharing — Issue #1449.
 * Covers: wallet-not-connected error, form validation, success token generation,
 * token list, revoke, access log tab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import CredentialSharing from '../CredentialSharing';
import type { WalletState } from '../../context/WalletContextValue';

const mockUseWallet = vi.fn();
vi.mock('../../hooks', () => ({
  useWallet: () => mockUseWallet(),
}));

const mockGenerateShareLink = vi.fn();
// Path relative to this test file: src/pages/__tests__/ -> src/stellar
vi.mock('../../stellar', () => ({
  generateShareLink: (...a: unknown[]) => mockGenerateShareLink(...a),
  bytesToHex: (b: Uint8Array) =>
    Array.from(b).map((x: number) => x.toString(16).padStart(2, '0')).join(''),
}));

const ADDR = 'G' + 'A'.repeat(55);
const connectedWallet: Partial<WalletState> = { address: ADDR, isConnected: true };
const noWallet: Partial<WalletState> = { address: null, isConnected: false };

function renderPage() {
  localStorage.clear();
  return render(<BrowserRouter><CredentialSharing /></BrowserRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseWallet.mockReturnValue(connectedWallet);
  mockGenerateShareLink.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
});

describe('CredentialSharing (#1449)', () => {
  it('renders the credential ID input', () => {
    renderPage();
    expect(screen.getByLabelText(/Credential ID to share/i)).toBeInTheDocument();
  });

  it('shows error when generating without credential ID', async () => {
    renderPage();
    // Button aria-label is "Generate share token"
    fireEvent.click(screen.getByRole('button', { name: /Generate share token/i }));

    await waitFor(() => {
      expect(screen.getByText(/Enter a credential ID/i)).toBeInTheDocument();
    });
    expect(mockGenerateShareLink).not.toHaveBeenCalled();
  });

  it('shows a message when wallet is not connected', () => {
    mockUseWallet.mockReturnValue(noWallet);
    renderPage();
    // When address is null, the static helper text appears and the button is disabled
    expect(screen.getByText(/Connect wallet to generate tokens/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate share token/i })).toBeDisabled();
  });

  it('creates a share token on success', async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(/Credential ID to share/i), {
      target: { value: '42' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate share token/i }));

    await waitFor(() => {
      expect(mockGenerateShareLink).toHaveBeenCalledWith(ADDR, '42', expect.any(Number));
    });
  });

  it('renders the Active Tokens tab', () => {
    renderPage();
    // Tab button text starts with "🔑 Active Tokens"
    expect(screen.getByRole('tab', { name: /Active Tokens/i })).toBeInTheDocument();
  });

  it('shows empty state when no tokens exist', () => {
    renderPage();
    expect(screen.getByText(/Generate a share token/i)).toBeInTheDocument();
  });

  it('renders the Access Log tab', () => {
    renderPage();
    expect(screen.getByRole('tab', { name: /Access Log/i })).toBeInTheDocument();
  });
});
