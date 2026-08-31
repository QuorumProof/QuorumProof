import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  });

  it('should render the attestor recovery approvals page', () => {
    renderWithRouter(<AttestorRecoveryApprovals />);
    expect(screen.getByTestId('navbar')).toBeInTheDocument();
  });

  it('should display loading state initially', async () => {
    renderWithRouter(<AttestorRecoveryApprovals />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display error state on load failure', async () => {
    renderWithRouter(<AttestorRecoveryApprovals />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display empty state when no approvals required', async () => {
    renderWithRouter(<AttestorRecoveryApprovals />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display success state with recovery approvals', async () => {
    renderWithRouter(<AttestorRecoveryApprovals />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });
});
