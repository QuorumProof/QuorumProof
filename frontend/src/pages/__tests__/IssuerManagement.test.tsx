import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import IssuerManagement from '../IssuerManagement';
import { useWallet } from '../../hooks';
import {
  getCredential,
  getCredentialsBySubject,
  getAttestors,
} from '../../lib/contracts/quorumProof';

vi.mock('../../components/Navbar', () => ({ Navbar: () => <div>Navbar</div> }));
vi.mock('../../hooks', () => ({
  useWallet: vi.fn(),
  useRealtimeUpdates: vi.fn(() => ({ status: 'polling', reconnect: vi.fn() })),
}));
vi.mock('../../lib/contracts/quorumProof', () => ({
  getCredential: vi.fn(),
  getCredentialsBySubject: vi.fn(),
  getAttestors: vi.fn(),
}));

const ISSUER = 'GISSUER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678901234';

const mockCred = (id: bigint, revoked = false) => ({
  id,
  subject: 'GSUBJECT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678901234',
  issuer: ISSUER,
  credential_type: 1,
  metadata_hash: new Uint8Array([1]),
  revoked,
  expires_at: null,
});

function renderPage() {
  return render(<BrowserRouter><IssuerManagement /></BrowserRouter>);
}

describe('IssuerManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows wallet required message when not connected', () => {
    vi.mocked(useWallet).mockReturnValue({ address: null } as any);
    renderPage();
    expect(screen.getByText('Wallet Required')).toBeInTheDocument();
  });

  it('renders credentials tab with issued credentials', async () => {
    vi.mocked(useWallet).mockReturnValue({ address: ISSUER } as any);
    vi.mocked(getCredentialsBySubject).mockResolvedValue([BigInt(1), BigInt(2)]);
    vi.mocked(getCredential).mockImplementation((id: bigint) => Promise.resolve(mockCred(id)));
    vi.mocked(getAttestors).mockResolvedValue([]);

    renderPage();
    await waitFor(() => {
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
    });
  });

  it('shows empty state when no credentials', async () => {
    vi.mocked(useWallet).mockReturnValue({ address: ISSUER } as any);
    vi.mocked(getCredentialsBySubject).mockResolvedValue([]);

    renderPage();
    await waitFor(() => {
      expect(screen.getByText('No credentials issued')).toBeInTheDocument();
    });
  });

  it('allows selecting credentials and bulk revoking', async () => {
    vi.mocked(useWallet).mockReturnValue({ address: ISSUER } as any);
    vi.mocked(getCredentialsBySubject).mockResolvedValue([BigInt(1)]);
    vi.mocked(getCredential).mockResolvedValue(mockCred(BigInt(1)));
    vi.mocked(getAttestors).mockResolvedValue([]);

    renderPage();
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Select credential 1'));
    fireEvent.click(screen.getByLabelText('Bulk revoke selected credentials'));

    await waitFor(() => {
      expect(screen.getByText(/Marked 1 credential/i)).toBeInTheDocument();
    });
  });

  it('shows error for invalid attestor address', async () => {
    vi.mocked(useWallet).mockReturnValue({ address: ISSUER } as any);
    vi.mocked(getCredentialsBySubject).mockResolvedValue([]);

    renderPage();
    await waitFor(() => expect(screen.getByText('No credentials issued')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: /Attestors/i }));
    fireEvent.change(screen.getByLabelText('New attestor address'), { target: { value: 'INVALID' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Attestor/i }));

    expect(screen.getByText(/Invalid Stellar address/i)).toBeInTheDocument();
  });

  it('accepts valid attestor address', async () => {
    vi.mocked(useWallet).mockReturnValue({ address: ISSUER } as any);
    vi.mocked(getCredentialsBySubject).mockResolvedValue([]);

    renderPage();
    await waitFor(() => expect(screen.getByText('No credentials issued')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: /Attestors/i }));
    fireEvent.change(screen.getByLabelText('New attestor address'), { target: { value: 'G' + 'A'.repeat(55) } });
    fireEvent.click(screen.getByRole('button', { name: /Add Attestor/i }));

    expect(screen.getByText(/Attestor .* added/i)).toBeInTheDocument();
  });

  it('select all toggles all credentials', async () => {
    vi.mocked(useWallet).mockReturnValue({ address: ISSUER } as any);
    vi.mocked(getCredentialsBySubject).mockResolvedValue([BigInt(1), BigInt(2)]);
    vi.mocked(getCredential).mockImplementation((id: bigint) => Promise.resolve(mockCred(id)));
    vi.mocked(getAttestors).mockResolvedValue([]);

    renderPage();
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Select all credentials'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });
});
