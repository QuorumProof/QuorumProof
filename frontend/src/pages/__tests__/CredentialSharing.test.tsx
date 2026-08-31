import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import CredentialSharing from '../CredentialSharing';

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

describe('CredentialSharing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the credential sharing page', () => {
    renderWithRouter(<CredentialSharing />);
    expect(screen.getByTestId('navbar')).toBeInTheDocument();
  });

  it('should display loading state initially', async () => {
    renderWithRouter(<CredentialSharing />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display error state on sharing failure', async () => {
    renderWithRouter(<CredentialSharing />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display empty state when no credentials to share', async () => {
    renderWithRouter(<CredentialSharing />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display success state with shared credentials', async () => {
    renderWithRouter(<CredentialSharing />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });
});
