/**
 * Tests for GdprRequest page — Issue #1447 (wallet-signed ownership) and
 * Issue #1449 (test coverage for newer pages).
 *
 * Coverage: submit (success, wrong-wallet error, missing wallet, signing
 * blocked), lookup (success, error), consent (success, error).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import GdprRequest from '../GdprRequest';
import type { WalletState } from '../../context/WalletContextValue';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../components/Navbar', () => ({ Navbar: () => <div>Navbar</div> }));

const mockGetCredential = vi.fn();
vi.mock('../../stellar', () => ({
  getCredential: (...args: unknown[]) => mockGetCredential(...args),
}));

const mockSignMessage = vi.fn();
vi.mock('@stellar/freighter-api', () => ({
  signMessage: (...args: unknown[]) => mockSignMessage(...args),
}));

const mockUseWallet = vi.fn();
vi.mock('../../hooks', () => ({
  useWallet: () => mockUseWallet(),
}));

const mockFetch = vi.fn<typeof fetch>();

const SUBJECT_ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER_ADDR   = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const connectedWallet: Partial<WalletState> = { address: SUBJECT_ADDR, isConnected: true };
const disconnectedWallet: Partial<WalletState> = { address: null, isConnected: false };

const mockCredential = {
  id: BigInt(42),
  subject: SUBJECT_ADDR,
  issuer: 'G' + 'I'.repeat(55),
  credential_type: 1,
  metadata_hash: new Uint8Array([1]),
  revoked: false,
  expires_at: null,
};

const validRecord = {
  requestId: 'gdpr_1',
  credentialId: 42,
  requestedAt: '2026-01-01T00:00:00.000Z',
  status: 'pending_consent',
  attestorConsents: [],
  requiredConsents: 2,
};

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function renderPage() {
  return render(<BrowserRouter><GdprRequest /></BrowserRouter>);
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockUseWallet.mockReturnValue(connectedWallet);
  mockGetCredential.mockResolvedValue(mockCredential);
  mockSignMessage.mockResolvedValue({ signedMessage: 'mock-sig-base64' });
  mockFetch.mockResolvedValue(makeResponse(200, validRecord));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ── Submit section ────────────────────────────────────────────────────────────

describe('GdprRequest — Submit flow', () => {
  it('shows a wallet-not-connected warning when no wallet is connected', () => {
    mockUseWallet.mockReturnValue(disconnectedWallet);
    renderPage();
    expect(screen.getByText(/Wallet not connected/i)).toBeInTheDocument();
  });

  it('submit button is disabled when no wallet is connected', () => {
    mockUseWallet.mockReturnValue(disconnectedWallet);
    renderPage();
    const btn = screen.getByRole('button', { name: /Submit Request/i });
    expect(btn).toBeDisabled();
  });

  it('shows an error without network call when credential ID is invalid', async () => {
    renderPage();
    // Leave credential ID empty (empty string parses to NaN)
    fireEvent.click(screen.getByRole('button', { name: /Submit Request/i }));

    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toBeInTheDocument();
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks submission when connected wallet does not match credential subject', async () => {
    mockUseWallet.mockReturnValue({ ...connectedWallet, address: OTHER_ADDR });
    renderPage();

    fireEvent.change(screen.getByLabelText(/Credential ID/i), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit Request/i }));

    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toHaveTextContent(
        /does not match the credential subject/i,
      );
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSignMessage).not.toHaveBeenCalled();
  });

  it('blocks submission when wallet signing fails', async () => {
    mockSignMessage.mockResolvedValue({ error: 'User rejected' });
    renderPage();

    fireEvent.change(screen.getByLabelText(/Credential ID/i), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit Request/i }));

    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toHaveTextContent(/Wallet signing failed/i);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('submits successfully with signature when subject matches', async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(/Credential ID/i), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit Request/i }));

    await waitFor(() => {
      expect(screen.getByText(/Request created/i)).toBeInTheDocument();
    });

    const [, init] = mockFetch.mock.calls[0] as [unknown, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toHaveProperty('signature', 'mock-sig-base64');
    expect(body).toHaveProperty('subjectAddress', SUBJECT_ADDR);
  });

  it('shows API error message on server error', async () => {
    mockFetch.mockResolvedValue(makeResponse(500, { error: 'Internal error' }));
    renderPage();

    fireEvent.change(screen.getByLabelText(/Credential ID/i), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit Request/i }));

    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toHaveTextContent('Internal error');
    });
  });
});

// ── Lookup section ────────────────────────────────────────────────────────────

describe('GdprRequest — Lookup flow', () => {
  it('shows validation error when request ID is empty', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Check Status/i }));

    await waitFor(() => {
      expect(screen.getByTestId('lookup-error')).toHaveTextContent('Enter a request ID');
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('displays the record on successful lookup', async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(/GDPR request ID/i), {
      target: { value: 'gdpr_1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Check Status/i }));

    await waitFor(() => {
      expect(screen.getByText('gdpr_1')).toBeInTheDocument();
    });
  });

  it('shows error message on lookup failure', async () => {
    mockFetch.mockResolvedValue(makeResponse(404, { error: 'Not found' }));
    renderPage();

    fireEvent.change(screen.getByLabelText(/GDPR request ID/i), {
      target: { value: 'gdpr_999' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Check Status/i }));

    await waitFor(() => {
      expect(screen.getByTestId('lookup-error')).toHaveTextContent('Not found');
    });
  });
});

// ── Consent section ───────────────────────────────────────────────────────────

describe('GdprRequest — Consent flow', () => {
  it('shows validation error when fields are empty', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Submit Consent/i }));

    await waitFor(() => {
      expect(screen.getByTestId('consent-error')).toHaveTextContent(
        /Both request ID and attestor address are required/i,
      );
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('displays consent result on success', async () => {
    const consentRecord = { ...validRecord, status: 'anonymized', attestorConsents: [SUBJECT_ADDR] };
    mockFetch.mockResolvedValue(makeResponse(200, consentRecord));
    renderPage();

    // The consent section has a request ID input with id="gdpr-consent-req"
    const consentReqInput = document.getElementById('gdpr-consent-req')!;
    const consentAddrInput = document.getElementById('gdpr-consent-addr')!;

    fireEvent.change(consentReqInput, { target: { value: 'gdpr_1' } });
    fireEvent.change(consentAddrInput, { target: { value: SUBJECT_ADDR } });
    fireEvent.click(screen.getByRole('button', { name: /Submit Consent/i }));

    await waitFor(() => {
      expect(screen.getByText(/Anonymized/i)).toBeInTheDocument();
    });
  });

  it('shows API error on consent failure', async () => {
    mockFetch.mockResolvedValue(makeResponse(403, { error: 'Consent rejected' }));
    renderPage();

    const consentReqInput = document.getElementById('gdpr-consent-req')!;
    const consentAddrInput = document.getElementById('gdpr-consent-addr')!;

    fireEvent.change(consentReqInput, { target: { value: 'gdpr_1' } });
    fireEvent.change(consentAddrInput, { target: { value: SUBJECT_ADDR } });
    fireEvent.click(screen.getByRole('button', { name: /Submit Consent/i }));

    await waitFor(() => {
      expect(screen.getByTestId('consent-error')).toHaveTextContent('Consent rejected');
    });
  });
});

// suppress unused import warning
void within;
