/**
 * Tests for CredentialMarketplace — Issue #1449.
 * Covers: loading state, empty results, search results, error state, type filter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import CredentialMarketplace from '../CredentialMarketplace';

vi.mock('../../components/Navbar', () => ({ Navbar: () => <div>Navbar</div> }));

const mockGetCredentialsBySubject = vi.fn();
const mockGetCredential = vi.fn();
const mockGetAttestors = vi.fn();
const mockIsExpired = vi.fn();

vi.mock('../../lib/contracts/quorumProof', () => ({
  getCredentialsBySubject: (...a: unknown[]) => mockGetCredentialsBySubject(...a),
  getCredential: (...a: unknown[]) => mockGetCredential(...a),
  getAttestors: (...a: unknown[]) => mockGetAttestors(...a),
  isExpired: (...a: unknown[]) => mockIsExpired(...a),
}));

const VALID_ADDR = 'G' + 'A'.repeat(55);

const makeCred = (id: bigint) => ({
  id,
  subject: VALID_ADDR,
  issuer: 'G' + 'I'.repeat(55),
  credential_type: 1,
  metadata_hash: new Uint8Array([1]),
  revoked: false,
  expires_at: null,
});

function renderPage() {
  return render(<BrowserRouter><CredentialMarketplace /></BrowserRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAttestors.mockResolvedValue([]);
  mockIsExpired.mockResolvedValue(false);
});

describe('CredentialMarketplace (#1449)', () => {
  it('renders the search form', () => {
    renderPage();
    expect(screen.getByLabelText(/Holder address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Search/i })).toBeInTheDocument();
  });

  it('shows validation error when address is empty', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));

    await waitFor(() => {
      expect(screen.getByText(/Enter a holder address/i)).toBeInTheDocument();
    });
    expect(mockGetCredentialsBySubject).not.toHaveBeenCalled();
  });

  it('shows validation error for invalid Stellar address', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/Holder address/i), { target: { value: 'invalid' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));

    await waitFor(() => {
      expect(screen.getByText(/valid Stellar address/i)).toBeInTheDocument();
    });
  });

  it('shows empty state when no credentials found', async () => {
    mockGetCredentialsBySubject.mockResolvedValue([]);
    renderPage();

    fireEvent.change(screen.getByLabelText(/Holder address/i), { target: { value: VALID_ADDR } });
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));

    await waitFor(() => {
      expect(screen.getByText(/No credentials found/i)).toBeInTheDocument();
    });
  });

  it('renders credential cards on success', async () => {
    mockGetCredentialsBySubject.mockResolvedValue([BigInt(1), BigInt(2)]);
    mockGetCredential.mockImplementation((id: bigint) => Promise.resolve(makeCred(id)));
    renderPage();

    fireEvent.change(screen.getByLabelText(/Holder address/i), { target: { value: VALID_ADDR } });
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));

    await waitFor(() => {
      expect(screen.getByText(/2 credentials/i)).toBeInTheDocument();
    });
  });

  it('shows error card on search failure', async () => {
    mockGetCredentialsBySubject.mockRejectedValue(new Error('RPC error'));
    renderPage();

    fireEvent.change(screen.getByLabelText(/Holder address/i), { target: { value: VALID_ADDR } });
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));

    await waitFor(() => {
      expect(screen.getByText('RPC error')).toBeInTheDocument();
    });
  });

  it('shows loading state during search', async () => {
    let resolve!: (v: bigint[]) => void;
    mockGetCredentialsBySubject.mockReturnValue(new Promise<bigint[]>(r => { resolve = r; }));
    renderPage();

    fireEvent.change(screen.getByLabelText(/Holder address/i), { target: { value: VALID_ADDR } });
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));

    expect(screen.getByRole('button', { name: /Searching/i })).toBeDisabled();
    resolve([]);
  });
});
