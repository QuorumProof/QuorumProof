import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import VerifierUI from '../VerifierUI';

vi.mock('../../components/Navbar', () => ({ Navbar: () => <div>Navbar</div> }));

vi.mock('../../lib/contracts/quorumProof', () => ({
  getCredential: vi.fn(),
  getCredentialsBySubject: vi.fn(),
  getAttestors: vi.fn(),
  isExpired: vi.fn(),
  isAttested: vi.fn(),
}));

vi.mock('../../stellar', () => ({
  decodeMetadataHash: vi.fn(() => 'test-hash'),
  CONTRACT_ID: 'CTEST123',
  RPC_URL: 'https://rpc.test',
  NETWORK: 'testnet',
  validateShareToken: vi.fn(),
  hexToUint8Array: vi.fn(),
}));

const mockCredential = {
  id: BigInt(1),
  subject: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B',
  issuer: 'GCZXWX4J3CKPF35VQ4XYVNIS7QQ5QEPL7SZLW5QJSTW2QC4QFSXZJWF',
  credential_type: 1,
  metadata_hash: new Uint8Array([1, 2, 3]),
  revoked: false,
  expires_at: null,
};

function renderVerifierUI() {
  return render(
    <BrowserRouter>
      <VerifierUI />
    </BrowserRouter>
  );
}

describe('VerifierUI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the verifier hero and search tabs', () => {
    renderVerifierUI();
    expect(screen.getByText('Credential Verification')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Credential ID/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Holder Address/i })).toBeInTheDocument();
  });

  it('shows error for invalid credential ID', async () => {
    renderVerifierUI();
    const input = screen.getByLabelText('Credential ID');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify/i }));
    await waitFor(() => {
      expect(screen.getByText(/valid credential ID/i)).toBeInTheDocument();
    });
  });

  it('fetches and displays credential details on valid ID', async () => {
    const { getCredential, getAttestors, isExpired, isAttested } = await import('../../lib/contracts/quorumProof');
    vi.mocked(getCredential).mockResolvedValue(mockCredential);
    vi.mocked(getAttestors).mockResolvedValue(['GATTESTOR1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678901234']);
    vi.mocked(isExpired).mockResolvedValue(false);
    vi.mocked(isAttested).mockResolvedValue(true);

    renderVerifierUI();
    const input = screen.getByLabelText('Credential ID');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify/i }));

    await waitFor(() => {
      expect(screen.getByText('Credential Verified')).toBeInTheDocument();
    });
    expect(screen.getByText('CREDENTIAL DETAILS')).toBeInTheDocument();
    expect(screen.getByText('ATTESTATION STATUS')).toBeInTheDocument();
    expect(screen.getByText(/Verified at:/i)).toBeInTheDocument();
  });

  it('shows revoked status for revoked credential', async () => {
    const { getCredential, getAttestors, isExpired, isAttested } = await import('../../lib/contracts/quorumProof');
    vi.mocked(getCredential).mockResolvedValue({ ...mockCredential, revoked: true });
    vi.mocked(getAttestors).mockResolvedValue([]);
    vi.mocked(isExpired).mockResolvedValue(false);
    vi.mocked(isAttested).mockResolvedValue(false);

    renderVerifierUI();
    fireEvent.change(screen.getByLabelText('Credential ID'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify/i }));

    await waitFor(() => {
      expect(screen.getByText('Credential Revoked')).toBeInTheDocument();
    });
  });

  it('switches to address tab and validates address format', async () => {
    renderVerifierUI();
    fireEvent.click(screen.getByRole('tab', { name: /Holder Address/i }));
    const input = screen.getByLabelText('Holder Stellar address');
    fireEvent.change(input, { target: { value: 'INVALID' } });
    // Wait for button to be enabled (not in loading state)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Look Up/i })).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole('button', { name: /Look Up/i }));
    await waitFor(() => {
      expect(screen.getByText(/valid Stellar address/i)).toBeInTheDocument();
    });
  });

  it('shows credential list when address has credentials', async () => {
    const { getCredentialsBySubject } = await import('../../lib/contracts/quorumProof');
    vi.mocked(getCredentialsBySubject).mockResolvedValue([BigInt(1), BigInt(2)]);

    renderVerifierUI();
    fireEvent.click(screen.getByRole('tab', { name: /Holder Address/i }));
    const input = screen.getByLabelText('Holder Stellar address');
    fireEvent.change(input, { target: { value: 'G' + 'A'.repeat(55) } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Look Up/i })).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole('button', { name: /Look Up/i }));

    await waitFor(() => {
      expect(screen.getByText('Credential #1')).toBeInTheDocument();
      expect(screen.getByText('Credential #2')).toBeInTheDocument();
    });
  });

  it('shows empty state when address has no credentials', async () => {
    const { getCredentialsBySubject } = await import('../../lib/contracts/quorumProof');
    vi.mocked(getCredentialsBySubject).mockResolvedValue([]);

    renderVerifierUI();
    fireEvent.click(screen.getByRole('tab', { name: /Holder Address/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Look Up/i })).not.toBeDisabled();
    });
    fireEvent.change(screen.getByLabelText('Holder Stellar address'), { target: { value: 'G' + 'A'.repeat(55) } });
    fireEvent.click(screen.getByRole('button', { name: /Look Up/i }));

    await waitFor(() => {
      expect(screen.getByText('No credentials found')).toBeInTheDocument();
    });
  });
});
