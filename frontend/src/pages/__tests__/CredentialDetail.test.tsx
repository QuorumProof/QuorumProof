import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CredentialDetail from '../CredentialDetail';
import * as quorumProof from '../../lib/contracts/quorumProof';

vi.mock('../../lib/contracts/quorumProof');
vi.mock('../../components/Navbar', () => ({
  Navbar: () => <div data-testid="navbar">Navbar</div>,
}));

const mockCredential = {
  id: 1n,
  subject: 'GSUBJECT123456789',
  issuer: 'GISSUER123456789',
  credential_type: 1,
  metadata_hash: new Uint8Array([72, 101, 108, 108, 111]), // "Hello"
  revoked: false,
  expires_at: 1704067200n,
};

describe('CredentialDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should display credential details', async () => {
    vi.mocked(quorumProof.getCredential).mockResolvedValue(mockCredential);
    vi.mocked(quorumProof.isExpired).mockResolvedValue(false);
    vi.mocked(quorumProof.getAttestors).mockResolvedValue(['GATT1', 'GATT2']);

    render(
      <MemoryRouter initialEntries={['/credential/1']}>
        <Routes>
          <Route path="/credential/:id" element={<CredentialDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Credential #1 ·/)).toBeInTheDocument();
      expect(screen.getAllByText('🎓 Degree').length).toBeGreaterThan(0);
      expect(screen.getByRole('status', { name: 'Credential status: Attested' })).toBeInTheDocument();
    });
  });

  it('should display error when credential fails to load', async () => {
    vi.mocked(quorumProof.getCredential).mockRejectedValue(
      new Error('Credential not found')
    );

    render(
      <MemoryRouter initialEntries={['/credential/999']}>
        <Routes>
          <Route path="/credential/:id" element={<CredentialDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Could Not Load Credential')).toBeInTheDocument();
      expect(screen.getByText('Credential not found')).toBeInTheDocument();
    });
  });

  it('should display attestors list', async () => {
    vi.mocked(quorumProof.getCredential).mockResolvedValue(mockCredential);
    vi.mocked(quorumProof.isExpired).mockResolvedValue(false);
    vi.mocked(quorumProof.getAttestors).mockResolvedValue(['GATT1', 'GATT2']);

    render(
      <MemoryRouter initialEntries={['/credential/1']}>
        <Routes>
          <Route path="/credential/:id" element={<CredentialDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('2 attestors')).toBeInTheDocument();
    });
  });

  it('should show revoked status', async () => {
    const revokedCred = { ...mockCredential, revoked: true };
    vi.mocked(quorumProof.getCredential).mockResolvedValue(revokedCred);
    vi.mocked(quorumProof.isExpired).mockResolvedValue(false);
    vi.mocked(quorumProof.getAttestors).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/credential/1']}>
        <Routes>
          <Route path="/credential/:id" element={<CredentialDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Credential status: Revoked' })).toBeInTheDocument();
    });
  });
});
