import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import GdprRequest from '../GdprRequest';
import { useWallet } from '../../context/WalletContextValue';

// Mock dependencies
vi.mock('../../context/WalletContextValue');
vi.mock('../../lib/gdprSigning');
vi.mock('../../components/Navbar', () => ({
  Navbar: () => <div data-testid="navbar">Navbar</div>,
}));

// Mock fetch
global.fetch = vi.fn();

const mockWalletContext = {
  address: 'GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH',
  isConnected: true,
  walletType: 'freighter',
  activeIndex: 0,
  accountIndex: 0,
  network: 'testnet',
  error: null,
  availableWallets: ['freighter'],
  disconnect: vi.fn(),
  switchWallet: vi.fn(),
  setAccountIndexForWallet: vi.fn(),
  wallets: ['GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH'],
};

function renderWithRouter(component: React.ReactElement) {
  return render(<BrowserRouter>{component}</BrowserRouter>);
}

describe('GdprRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useWallet as any).mockReturnValue(mockWalletContext);
    (global.fetch as any).mockClear();
  });

  describe('wallet integration', () => {
    it('should show wallet connection warning when not connected', () => {
      (useWallet as any).mockReturnValue({
        ...mockWalletContext,
        isConnected: false,
        address: null,
      });

      renderWithRouter(<GdprRequest />);

      expect(screen.getByText(/Wallet Required/)).toBeInTheDocument();
    });

    it('should display connected wallet address', () => {
      renderWithRouter(<GdprRequest />);

      expect(screen.getByText(/Connected:/)).toBeInTheDocument();
      expect(screen.getByText(/GAX.*YPAHH/)).toBeInTheDocument();
    });

    it('should disable submit button when wallet not connected', () => {
      (useWallet as any).mockReturnValue({
        ...mockWalletContext,
        isConnected: false,
        address: null,
      });

      renderWithRouter(<GdprRequest />);

      const submitButton = screen.getByText(/Connect Wallet First/);
      expect(submitButton).toBeDisabled();
    });
  });

  describe('submit request flow', () => {
    it('should require credential ID input', async () => {
      const { createSignedGdprRequest } = await import('../../lib/gdprSigning');
      (createSignedGdprRequest as any).mockResolvedValue({
        credentialId: 42,
        challenge: 'test_challenge',
        signature: 'test_signature',
        subjectAddress: mockWalletContext.address,
      });

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          requestId: 'gdpr_123',
          credentialId: 42,
          status: 'pending_consent',
          requiredConsents: 2,
          attestorConsents: [],
        }),
      });

      renderWithRouter(<GdprRequest />);

      // Try to submit without credential ID
      const submitButton = screen.getByRole('button', { name: /Submit Request/ });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Enter a valid credential ID/)).toBeInTheDocument();
      });
    });

    it('should require wallet connection to submit', async () => {
      (useWallet as any).mockReturnValue({
        ...mockWalletContext,
        isConnected: false,
        address: null,
      });

      renderWithRouter(<GdprRequest />);

      const credInput = screen.getByLabelText(/Credential ID/);
      fireEvent.change(credInput, { target: { value: '42' } });

      const submitButton = screen.getByRole('button', { name: /Connect Wallet First/ });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Please connect your wallet/)).toBeInTheDocument();
      });
    });

    it('should sign request with wallet and send to API', async () => {
      const { createSignedGdprRequest } = await import('../../lib/gdprSigning');
      const signedPayload = {
        credentialId: 42,
        challenge: 'challenge_abc',
        signature: 'sig_base64==',
        subjectAddress: mockWalletContext.address,
      };
      (createSignedGdprRequest as any).mockResolvedValue(signedPayload);

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          requestId: 'gdpr_456',
          credentialId: 42,
          status: 'pending_consent',
          requiredConsents: 2,
          attestorConsents: [],
        }),
      });

      renderWithRouter(<GdprRequest />);

      const credInput = screen.getByLabelText(/Credential ID/);
      fireEvent.change(credInput, { target: { value: '42' } });

      const submitButton = screen.getByRole('button', { name: /Submit Request/ });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(createSignedGdprRequest).toHaveBeenCalledWith(42, mockWalletContext.address);
      });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/gdpr/request'),
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify(signedPayload),
          })
        );
      });
    });

    it('should show error when wallet signature is denied', async () => {
      const { createSignedGdprRequest } = await import('../../lib/gdprSigning');
      (createSignedGdprRequest as any).mockRejectedValue(new Error('User denied signing'));

      renderWithRouter(<GdprRequest />);

      const credInput = screen.getByLabelText(/Credential ID/);
      fireEvent.change(credInput, { target: { value: '42' } });

      const submitButton = screen.getByRole('button', { name: /Submit Request/ });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Signature request cancelled/)).toBeInTheDocument();
      });
    });

    it('should show wallet mismatch error on 403 response', async () => {
      const { createSignedGdprRequest } = await import('../../lib/gdprSigning');
      (createSignedGdprRequest as any).mockResolvedValue({
        credentialId: 42,
        challenge: 'test_challenge',
        signature: 'test_signature',
        subjectAddress: mockWalletContext.address,
      });

      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({
          error: 'Wallet address does not match credential subject',
        }),
      });

      renderWithRouter(<GdprRequest />);

      const credInput = screen.getByLabelText(/Credential ID/);
      fireEvent.change(credInput, { target: { value: '42' } });

      const submitButton = screen.getByRole('button', { name: /Submit Request/ });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Wallet address does not match/)).toBeInTheDocument();
      });
    });
  });

  describe('lookup flow', () => {
    it('should fetch request status by ID', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          requestId: 'gdpr_123',
          credentialId: 42,
          status: 'pending_consent',
          requiredConsents: 2,
          attestorConsents: ['ADDR1'],
        }),
      });

      renderWithRouter(<GdprRequest />);

      const lookupInput = screen.getByLabelText(/GDPR request ID/);
      fireEvent.change(lookupInput, { target: { value: 'gdpr_123' } });

      const checkButton = screen.getByRole('button', { name: /Check Status/ });
      fireEvent.click(checkButton);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/gdpr/request/gdpr_123')
        );
      });
    });

    it('should show error on lookup failure', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Request not found' }),
      });

      renderWithRouter(<GdprRequest />);

      const lookupInput = screen.getByLabelText(/GDPR request ID/);
      fireEvent.change(lookupInput, { target: { value: 'invalid_id' } });

      const checkButton = screen.getByRole('button', { name: /Check Status/ });
      fireEvent.click(checkButton);

      await waitFor(() => {
        expect(screen.getByText(/Request not found/)).toBeInTheDocument();
      });
    });
  });

  describe('consent flow', () => {
    it('should require both request ID and attestor address', async () => {
      renderWithRouter(<GdprRequest />);

      const consentButton = screen.getByRole('button', { name: /Submit Consent/ });
      fireEvent.click(consentButton);

      await waitFor(() => {
        expect(screen.getByText(/Both request ID and attestor address are required/)).toBeInTheDocument();
      });
    });

    it('should submit consent with request ID and attestor address', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          requestId: 'gdpr_123',
          credentialId: 42,
          status: 'pending_consent',
          requiredConsents: 2,
          attestorConsents: ['ADDR1', 'ADDR2'],
        }),
      });

      renderWithRouter(<GdprRequest />);

      const reqInput = screen.getByLabelText(/^Request ID/);
      const addrInput = screen.getByLabelText(/Your Attestor Address/);

      fireEvent.change(reqInput, { target: { value: 'gdpr_123' } });
      fireEvent.change(addrInput, { target: { value: 'GADDR1' } });

      const consentButton = screen.getByRole('button', { name: /Submit Consent/ });
      fireEvent.click(consentButton);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/gdpr/consent'),
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              requestId: 'gdpr_123',
              attestorAddress: 'GADDR1',
            }),
          })
        );
      });
    });
  });

  describe('error states', () => {
    it('should display error messages for invalid credential ID', async () => {
      renderWithRouter(<GdprRequest />);

      const credInput = screen.getByLabelText(/Credential ID/);
      fireEvent.change(credInput, { target: { value: '0' } });

      const submitButton = screen.getByRole('button', { name: /Submit Request/ });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Enter a valid credential ID/)).toBeInTheDocument();
      });
    });

    it('should display network errors', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      const { createSignedGdprRequest } = await import('../../lib/gdprSigning');
      (createSignedGdprRequest as any).mockResolvedValue({
        credentialId: 42,
        challenge: 'test',
        signature: 'sig',
        subjectAddress: mockWalletContext.address,
      });

      renderWithRouter(<GdprRequest />);

      const credInput = screen.getByLabelText(/Credential ID/);
      fireEvent.change(credInput, { target: { value: '42' } });

      const submitButton = screen.getByRole('button', { name: /Submit Request/ });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Network error/)).toBeInTheDocument();
      });
    });
  });
});
