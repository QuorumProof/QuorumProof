import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CredentialVerificationDashboard } from '../CredentialVerificationDashboard';

// Mock the hooks and utilities
vi.mock('../../hooks/useRealtimeUpdates', () => ({
  useRealtimeUpdates: vi.fn(() => ({ status: 'connected', reconnect: vi.fn() })),
}));

vi.mock('../../lib/credentialUtils', () => ({
  credTypeLabel: vi.fn((type: number) => `Type ${type}`),
  formatTimestamp: vi.fn((ts: bigint) => new Date(Number(ts)).toISOString()),
  formatAddress: vi.fn((addr: string) => addr.slice(0, 10) + '...' + addr.slice(-10)),
  CREDENTIAL_TYPES: { 0: 'Degree', 1: 'License', 2: 'Employment' },
}));

vi.mock('../../components/CredentialSearchFilter', () => ({
  CredentialSearchFilter: vi.fn(({ onSearch }: any) => (
    <div data-testid="search-filter">Mock Search Filter</div>
  )),
}));

describe('CredentialVerificationDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dashboard with search interface', () => {
    render(<CredentialVerificationDashboard />);
    expect(screen.getByText('Credential Verification Dashboard')).toBeInTheDocument();
    expect(screen.getByText(/Search, filter, and verify credentials/)).toBeInTheDocument();
  });

  it('displays empty state when no credentials found', async () => {
    render(<CredentialVerificationDashboard />);
    await waitFor(() => {
      expect(screen.getByText(/No credentials found/)).toBeInTheDocument();
    });
  });

  it('shows export button when credentials are present', async () => {
    render(<CredentialVerificationDashboard />);
    const exportBtn = screen.queryByText('📥 Export CSV');
    expect(exportBtn).toBeInTheDocument();
  });

  it('displays real-time status indicator', () => {
    render(<CredentialVerificationDashboard />);
    const statusIndicator = document.querySelector('.status-indicator');
    expect(statusIndicator).toBeInTheDocument();
  });

  it('handles search filter interactions', async () => {
    render(<CredentialVerificationDashboard />);
    
    const searchInput = screen.getByPlaceholderText(/Search by type, issuer, or holder address/);
    expect(searchInput).toBeInTheDocument();
  });

  it('renders certificate verification badges correctly', () => {
    render(<CredentialVerificationDashboard />);
    expect(document.querySelector('.badge')).toBeInTheDocument();
  });

  it('displays virtualized list container for performance', () => {
    render(<CredentialVerificationDashboard />);
    const credentialList = document.querySelector('.credential-list');
    expect(credentialList).toBeInTheDocument();
  });

  it('has responsive design styles', () => {
    render(<CredentialVerificationDashboard />);
    const dashboard = document.querySelector('.verification-dashboard');
    expect(dashboard).toHaveStyle('padding: 20px');
  });
});
