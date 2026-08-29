/**
 * Tests for CredentialRecovery — Issue #1449.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import CredentialRecovery from '../CredentialRecovery';

vi.mock('../../components/Navbar', () => ({ Navbar: () => <div>Navbar</div> }));

const mockFetch = vi.fn<typeof fetch>();

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const VALID_ADDR  = 'G' + 'A'.repeat(55);
const VALID_ADDR2 = 'G' + 'B'.repeat(55);

function renderPage() {
  return render(<BrowserRouter><CredentialRecovery /></BrowserRouter>);
}

// Helper: fill and submit step 1
async function completeStep1() {
  fireEvent.change(screen.getByPlaceholderText(/GABC.*XYZ.*56-character/i), {
    target: { value: VALID_ADDR },
  });
  fireEvent.change(screen.getByPlaceholderText(/e\.g\. 42 or abc123/i), {
    target: { value: '42' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: /New Wallet.*Contact/i })).toBeInTheDocument(),
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockResolvedValue(makeResponse(200, { requestId: 'rec_1' }));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('CredentialRecovery (#1449)', () => {
  it('renders step 1 of the recovery wizard', () => {
    renderPage();
    expect(screen.getByText(/Lost Wallet Address/i)).toBeInTheDocument();
  });

  it('shows validation error when lost wallet address is invalid on step 1', async () => {
    renderPage();

    fireEvent.change(screen.getByPlaceholderText(/GABC.*XYZ.*56-character/i), {
      target: { value: 'not-a-stellar-address' },
    });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 42 or abc123/i), {
      target: { value: '42' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => {
      expect(screen.getByText(/valid Stellar address/i)).toBeInTheDocument();
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows validation error when credential ID is missing on step 1', async () => {
    renderPage();

    fireEvent.change(screen.getByPlaceholderText(/GABC.*XYZ.*56-character/i), {
      target: { value: VALID_ADDR },
    });
    // leave credential ID empty
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => {
      expect(screen.getByText(/Credential ID is required/i)).toBeInTheDocument();
    });
  });

  it('advances to step 2 with valid step-1 data', async () => {
    renderPage();
    await completeStep1();
    expect(screen.getByRole('heading', { name: /New Wallet.*Contact/i })).toBeInTheDocument();
  });

  it('shows error when new wallet equals lost wallet in step 2', async () => {
    renderPage();
    await completeStep1();

    // Set new wallet same as lost wallet
    fireEvent.change(screen.getByPlaceholderText(/GABC.*XYZ.*56-character/i), {
      target: { value: VALID_ADDR },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send Verification Code/i }));

    await waitFor(() => {
      expect(screen.getByText(/must differ from the lost wallet/i)).toBeInTheDocument();
    });
  });

  it('submits and advances to OTP step on valid step 2', async () => {
    renderPage();
    await completeStep1();

    fireEvent.change(screen.getByPlaceholderText(/GABC.*XYZ.*56-character/i), {
      target: { value: VALID_ADDR2 },
    });
    fireEvent.change(screen.getByPlaceholderText(/you@example\.com/i), {
      target: { value: 'test@example.com' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Send Verification Code/i }));

    await waitFor(() => {
      // OTP step shows verification code input
      expect(screen.getByPlaceholderText('______')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('shows network error when API call fails', async () => {
    mockFetch.mockResolvedValue(makeResponse(500, { error: 'Server error' }));
    renderPage();
    await completeStep1();

    fireEvent.change(screen.getByPlaceholderText(/GABC.*XYZ.*56-character/i), {
      target: { value: VALID_ADDR2 },
    });
    fireEvent.change(screen.getByPlaceholderText(/you@example\.com/i), {
      target: { value: 'test@example.com' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Send Verification Code/i }));

    await waitFor(() => {
      // After failure the error text should appear
      expect(screen.queryByText(/Server error|error|failed|Could not/i)).toBeTruthy();
    }, { timeout: 3000 });
  });
});
