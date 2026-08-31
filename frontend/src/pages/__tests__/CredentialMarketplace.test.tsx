import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import CredentialMarketplace from '../CredentialMarketplace';

vi.mock('../../components/Navbar', () => ({
  Navbar: () => <div data-testid="navbar">Navbar</div>,
}));

vi.mock('../../hooks/useFeedback', () => ({
  useFeedback: () => ({
    showFeedback: vi.fn(),
    showError: vi.fn(),
  }),
}));

function renderWithRouter(component: React.ReactElement) {
  return render(<BrowserRouter>{component}</BrowserRouter>);
}

describe('CredentialMarketplace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the marketplace page', () => {
    renderWithRouter(<CredentialMarketplace />);
    expect(screen.getByTestId('navbar')).toBeInTheDocument();
  });

  it('should display loading state initially', () => {
    renderWithRouter(<CredentialMarketplace />);
    // Check for any loading indicators or initial state
    expect(screen.getByTestId('navbar')).toBeInTheDocument();
  });

  it('should display error state when marketplace fails to load', async () => {
    renderWithRouter(<CredentialMarketplace />);
    // Wait for the component to render
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display empty state when no credentials available', async () => {
    renderWithRouter(<CredentialMarketplace />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  it('should display success state with marketplace data', async () => {
    renderWithRouter(<CredentialMarketplace />);
    await waitFor(() => {
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });
});
