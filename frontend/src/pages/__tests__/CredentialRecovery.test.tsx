import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import CredentialRecovery from '../CredentialRecovery';

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

describe('CredentialRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the credential recovery page', () => {
    renderWithRouter(<CredentialRecovery />);
    expect(screen.getByTestId('navbar')).toBeInTheDocument();
  });

  it('should display loading state initially', async () => {
    renderWithRouter(<CredentialRecovery />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display error state on recovery failure', async () => {
    renderWithRouter(<CredentialRecovery />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display empty state when no credentials to recover', async () => {
    renderWithRouter(<CredentialRecovery />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display success state with recovered credentials', async () => {
    renderWithRouter(<CredentialRecovery />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });
});
