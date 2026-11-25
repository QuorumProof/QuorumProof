import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import AttestorRecoveryApprovals from '../AttestorRecoveryApprovals';

vi.mock('../../components/Navbar', () => ({
  Navbar: () => <div data-testid="navbar">Navbar</div>,
}));

vi.mock('../../context/WalletContextValue', () => ({
  useWallet: () => ({
    address: 'GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH',
    isConnected: true,
  }),
}));

function renderWithRouter(component: React.ReactElement) {
  return render(<BrowserRouter>{component}</BrowserRouter>);
}

describe('AttestorRecoveryApprovals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should render the attestor recovery approvals page', () => {
    renderWithRouter(<AttestorRecoveryApprovals />);
    expect(screen.getByTestId('navbar')).toBeInTheDocument();
  });

  it('shows an empty state when the API returns no requests', async () => {
    renderWithRouter(<AttestorRecoveryApprovals />);
    expect(await screen.findByText('No pending recovery requests.')).toBeInTheDocument();
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
  });

  it('shows an error instead of requests when loading fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));
    renderWithRouter(<AttestorRecoveryApprovals />);
    expect(await screen.findByText('Failed to load recovery requests. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText('No pending recovery requests.')).not.toBeInTheDocument();
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
  });
});
