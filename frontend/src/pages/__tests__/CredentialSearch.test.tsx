import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import CredentialSearch, { applyFilters } from '../CredentialSearch';
import type { SearchFilters } from '../CredentialSearch';
import type { Credential } from '../../lib/contracts/quorumProof';

vi.mock('../../components/Navbar', () => ({ Navbar: () => <div>Navbar</div> }));

vi.mock('../../lib/contracts/quorumProof', () => ({
  getCredential: vi.fn(),
  getCredentialsBySubject: vi.fn(),
  getAttestors: vi.fn(),
  isExpired: vi.fn(),
}));

vi.mock('../../lib/exportUtils', () => ({
  exportCredentials: vi.fn(),
}));

const makeCred = (id: bigint, overrides: Partial<Credential> = {}): Credential => ({
  id,
  subject: 'G' + 'S'.repeat(55),
  issuer: 'G' + 'I'.repeat(55),
  credential_type: 1,
  metadata_hash: new Uint8Array([1]),
  revoked: false,
  expires_at: null,
  ...overrides,
});

const VALID_ADDR = 'G' + 'A'.repeat(55);

function renderPage() {
  return render(<BrowserRouter><CredentialSearch /></BrowserRouter>);
}

describe('CredentialSearch — applyFilters (pure)', () => {
  const base = [
    { credential: makeCred(1n), attestors: [], expired: false },
    { credential: makeCred(2n, { revoked: true }), attestors: [], expired: false },
    { credential: makeCred(3n), attestors: [], expired: true },
    { credential: makeCred(4n, { credential_type: 2 }), attestors: [], expired: false },
    { credential: makeCred(5n, { issuer: 'G' + 'X'.repeat(55) }), attestors: [], expired: false },
  ];

  const emptyFilters: SearchFilters = { subject: '', issuer: '', credentialType: '', status: 'all', startDate: '', endDate: '' };

  it('returns all results with empty filters', () => {
    expect(applyFilters(base, emptyFilters)).toHaveLength(5);
  });

  it('filters by status=active', () => {
    const res = applyFilters(base, { ...emptyFilters, status: 'active' });
    expect(res.every((r) => !r.credential.revoked && !r.expired)).toBe(true);
  });

  it('filters by status=revoked', () => {
    const res = applyFilters(base, { ...emptyFilters, status: 'revoked' });
    expect(res.every((r) => r.credential.revoked)).toBe(true);
    expect(res).toHaveLength(1);
  });

  it('filters by status=expired', () => {
    const res = applyFilters(base, { ...emptyFilters, status: 'expired' });
    expect(res.every((r) => r.expired)).toBe(true);
    expect(res).toHaveLength(1);
  });

  it('filters by credential type', () => {
    const res = applyFilters(base, { ...emptyFilters, credentialType: '2' });
    expect(res).toHaveLength(1);
    expect(res[0].credential.id).toBe(4n);
  });

  it('filters by issuer substring', () => {
    const res = applyFilters(base, { ...emptyFilters, issuer: 'X' });
    expect(res).toHaveLength(1);
    expect(res[0].credential.id).toBe(5n);
  });
});

describe('CredentialSearch — UI', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders search form', () => {
    renderPage();
    expect(screen.getByText('Search & Filter Credentials')).toBeInTheDocument();
    expect(screen.getByLabelText('Subject address')).toBeInTheDocument();
    expect(screen.getByLabelText('Credential type')).toBeInTheDocument();
    expect(screen.getByLabelText('Credential status')).toBeInTheDocument();
  });

  it('shows error when subject is empty', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));
    await waitFor(() => {
      expect(screen.getByText(/Subject address is required/i)).toBeInTheDocument();
    });
  });

  it('shows error for invalid subject address', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Subject address'), { target: { value: 'INVALID' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));
    await waitFor(() => {
      expect(screen.getByText(/valid Stellar address/i)).toBeInTheDocument();
    });
  });

  it('displays results after successful search', async () => {
    const { getCredentialsBySubject, getCredential, getAttestors, isExpired } = await import('../../lib/contracts/quorumProof');
    vi.mocked(getCredentialsBySubject).mockResolvedValue([BigInt(1)]);
    vi.mocked(getCredential).mockResolvedValue(makeCred(1n));
    vi.mocked(getAttestors).mockResolvedValue([]);
    vi.mocked(isExpired).mockResolvedValue(false);

    renderPage();
    fireEvent.change(screen.getByLabelText('Subject address'), { target: { value: VALID_ADDR } });
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));

    await waitFor(() => {
      expect(screen.getByText('#1')).toBeInTheDocument();
    });
    expect(screen.getByText('1 credential')).toBeInTheDocument();
  });

  it('shows empty state when no results match filters', async () => {
    const { getCredentialsBySubject, getCredential, getAttestors, isExpired } = await import('../../lib/contracts/quorumProof');
    vi.mocked(getCredentialsBySubject).mockResolvedValue([BigInt(1)]);
    vi.mocked(getCredential).mockResolvedValue(makeCred(1n));
    vi.mocked(getAttestors).mockResolvedValue([]);
    vi.mocked(isExpired).mockResolvedValue(false);

    renderPage();
    fireEvent.change(screen.getByLabelText('Subject address'), { target: { value: VALID_ADDR } });
    // Filter to revoked only — our cred is not revoked
    fireEvent.change(screen.getByLabelText('Credential status'), { target: { value: 'revoked' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));

    await waitFor(() => {
      expect(screen.getByText('No credentials match your filters')).toBeInTheDocument();
    });
  });

  it('shows export buttons after results', async () => {
    const { getCredentialsBySubject, getCredential, getAttestors, isExpired } = await import('../../lib/contracts/quorumProof');
    vi.mocked(getCredentialsBySubject).mockResolvedValue([BigInt(1)]);
    vi.mocked(getCredential).mockResolvedValue(makeCred(1n));
    vi.mocked(getAttestors).mockResolvedValue([]);
    vi.mocked(isExpired).mockResolvedValue(false);

    renderPage();
    fireEvent.change(screen.getByLabelText('Subject address'), { target: { value: VALID_ADDR } });
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Export as JSON')).toBeInTheDocument();
      expect(screen.getByLabelText('Export as CSV')).toBeInTheDocument();
    });
  });

  it('calls exportCredentials on export click', async () => {
    const { getCredentialsBySubject, getCredential, getAttestors, isExpired } = await import('../../lib/contracts/quorumProof');
    const { exportCredentials } = await import('../../lib/exportUtils');
    vi.mocked(getCredentialsBySubject).mockResolvedValue([BigInt(1)]);
    vi.mocked(getCredential).mockResolvedValue(makeCred(1n));
    vi.mocked(getAttestors).mockResolvedValue([]);
    vi.mocked(isExpired).mockResolvedValue(false);

    renderPage();
    fireEvent.change(screen.getByLabelText('Subject address'), { target: { value: VALID_ADDR } });
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));

    await waitFor(() => expect(screen.getByLabelText('Export as JSON')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Export as JSON'));
    expect(exportCredentials).toHaveBeenCalledWith(expect.any(Array), 'json');
  });

  it('resets filters and results on Reset click', async () => {
    const { getCredentialsBySubject, getCredential, getAttestors, isExpired } = await import('../../lib/contracts/quorumProof');
    vi.mocked(getCredentialsBySubject).mockResolvedValue([BigInt(1)]);
    vi.mocked(getCredential).mockResolvedValue(makeCred(1n));
    vi.mocked(getAttestors).mockResolvedValue([]);
    vi.mocked(isExpired).mockResolvedValue(false);

    renderPage();
    fireEvent.change(screen.getByLabelText('Subject address'), { target: { value: VALID_ADDR } });
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Reset/i }));
    expect(screen.queryByText('#1')).not.toBeInTheDocument();
    expect((screen.getByLabelText('Subject address') as HTMLInputElement).value).toBe('');
  });
});
