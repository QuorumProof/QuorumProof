/**
 * Tests for VerificationDashboard — Issue #1449.
 * The page is a thin shell around CredentialVerificationDashboard; tests
 * verify the shell renders and the inner component is included.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import VerificationDashboard from '../VerificationDashboard';

vi.mock('../../components/Navbar', () => ({ Navbar: () => <div>Navbar</div> }));

vi.mock('../../components/CredentialVerificationDashboard', () => ({
  CredentialVerificationDashboard: () => (
    <div data-testid="credential-verification-dashboard">CredentialVerificationDashboard</div>
  ),
}));

function renderPage() {
  return render(<BrowserRouter><VerificationDashboard /></BrowserRouter>);
}

describe('VerificationDashboard (#1449)', () => {
  it('renders without crashing', () => {
    renderPage();
    expect(screen.getByTestId('credential-verification-dashboard')).toBeInTheDocument();
  });

  it('includes the Navbar', () => {
    renderPage();
    expect(screen.getByText('Navbar')).toBeInTheDocument();
  });

  it('renders the footer with Stellar attribution', () => {
    renderPage();
    expect(screen.getByText(/Stellar Soroban/i)).toBeInTheDocument();
  });

  it('renders the CredentialVerificationDashboard component', () => {
    renderPage();
    expect(screen.getByText('CredentialVerificationDashboard')).toBeInTheDocument();
  });
});
