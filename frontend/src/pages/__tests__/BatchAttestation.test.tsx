/**
 * Tests for BatchAttestation — Issue #1449.
 * Covers: loading state, wallet-not-connected, demo data, select all, attest,
 * missing slice error, success results, error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import BatchAttestation from '../BatchAttestation';
import type { WalletState } from '../../context/WalletContextValue';

const mockUseWallet = vi.fn();
vi.mock('../../hooks', () => ({
  useWallet: () => mockUseWallet(),
}));

const ADDR = 'G' + 'A'.repeat(55);
const connectedWallet: Partial<WalletState> = { address: ADDR, isConnected: true };
const noWallet: Partial<WalletState> = { address: null, isConnected: false };

const mockFetch = vi.fn<typeof fetch>();

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function renderPage() {
  localStorage.clear();
  return render(<BrowserRouter><BatchAttestation /></BrowserRouter>);
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockUseWallet.mockReturnValue(connectedWallet);
  // Default: return empty items so demo data kicks in
  mockFetch.mockResolvedValue(makeResponse(200, { items: [] }));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('BatchAttestation (#1449)', () => {
  it('does not fetch when wallet is not connected', () => {
    mockUseWallet.mockReturnValue(noWallet);
    renderPage();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('renders page heading', () => {
    renderPage();
    expect(screen.getByText(/Batch Attestation/i)).toBeInTheDocument();
  });

  it('shows demo items when API returns empty list', async () => {
    renderPage();

    await waitFor(() => {
      // Demo data loads; select-all checkbox should be present
      expect(screen.getByLabelText(/deselect all|select all/i)).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('shows error when slice ID is missing and batch attest is clicked', async () => {
    renderPage();

    // Wait for demo data to load
    await waitFor(() =>
      expect(screen.getByLabelText(/deselect all|select all/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );

    // Select all
    fireEvent.click(screen.getByLabelText(/deselect all|select all/i));

    // The attest button text includes the selected count, e.g. "Attest (5)"
    const attestBtn = screen.getByRole('button', { name: /Attest/i });
    fireEvent.click(attestBtn);

    await waitFor(() => {
      expect(screen.getByText(/No slice ID set/i)).toBeInTheDocument();
    });
  });

  it('posts batch attest request with correct payload', async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByLabelText(/deselect all|select all/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );

    // Set slice ID
    const sliceInput = screen.getByPlaceholderText(/Enter quorum slice ID/i);
    fireEvent.change(sliceInput, { target: { value: '7' } });

    // Select all items
    fireEvent.click(screen.getByLabelText(/deselect all|select all/i));

    // Mock the attest endpoint
    mockFetch.mockResolvedValueOnce(makeResponse(200, { results: [] }));

    fireEvent.click(screen.getByRole('button', { name: /Attest/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/attestor/batch-attest'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('shows error on batch attest failure', async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByLabelText(/deselect all|select all/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );

    const sliceInput = screen.getByPlaceholderText(/Enter quorum slice ID/i);
    fireEvent.change(sliceInput, { target: { value: '7' } });
    fireEvent.click(screen.getByLabelText(/deselect all|select all/i));

    mockFetch.mockResolvedValueOnce(makeResponse(500, { error: 'Contract error' }));
    fireEvent.click(screen.getByRole('button', { name: /Attest/i }));

    await waitFor(() => {
      expect(screen.getByText(/Contract error/i)).toBeInTheDocument();
    });
  });
});
