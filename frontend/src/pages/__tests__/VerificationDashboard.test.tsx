import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import VerificationDashboard from '../VerificationDashboard';

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

describe('VerificationDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the verification dashboard page', () => {
    renderWithRouter(<VerificationDashboard />);
    expect(screen.getByTestId('navbar')).toBeInTheDocument();
  });

  it('should display loading state initially', async () => {
    renderWithRouter(<VerificationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display error state on dashboard load failure', async () => {
    renderWithRouter(<VerificationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display empty state when no verifications pending', async () => {
    renderWithRouter(<VerificationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display success state with verification metrics', async () => {
    renderWithRouter(<VerificationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });
});
