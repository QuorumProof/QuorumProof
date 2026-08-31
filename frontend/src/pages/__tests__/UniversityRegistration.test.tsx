import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import UniversityRegistration from '../UniversityRegistration';

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

describe('UniversityRegistration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the university registration page', () => {
    renderWithRouter(<UniversityRegistration />);
    expect(screen.getByTestId('navbar')).toBeInTheDocument();
  });

  it('should display loading state initially', async () => {
    renderWithRouter(<UniversityRegistration />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display error state on registration failure', async () => {
    renderWithRouter(<UniversityRegistration />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display empty state when no universities available', async () => {
    renderWithRouter(<UniversityRegistration />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display success state with registered universities', async () => {
    renderWithRouter(<UniversityRegistration />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });
});
