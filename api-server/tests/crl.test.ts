import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCredentialsRouter } from '../src/routes/credentials.js';

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as any,
  u32Val: (n: number) => n as any,
  addressVal: (a: string) => a as any,
};

const app = express();
app.use(express.json());
app.use('/api/credentials', createCredentialsRouter(mockSoroban));

const revokedCred = {
  id: '2',
  subject: 'GABC',
  issuer: 'GISSUER',
  credential_type: 1,
  revoked: true,
  suspended: false,
  expires_at: null,
  metadata_hash: 'hash2',
  updated_at: '2024-01-15T10:00:00.000Z',
  version: 1,
};

const activeCred = {
  id: '1',
  subject: 'GDEF',
  issuer: 'GISSUER',
  credential_type: 1,
  revoked: false,
  suspended: false,
  expires_at: null,
  metadata_hash: 'hash1',
  version: 1,
};

describe('GET /api/credentials/crl', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns JSON CRL with revoked credentials', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(activeCred)
      .mockResolvedValueOnce(revokedCred);

    const res = await request(app).get('/api/credentials/crl');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.totalRevoked).toBe(1);
    expect(res.body.revokedCertificates).toHaveLength(1);
    expect(res.body.revokedCertificates[0].serialNumber).toBe('2');
    expect(res.body.revokedCertificates[0].reason).toBe('unspecified');
    expect(res.body.issuer).toBe('QuorumProof');
    expect(res.body.thisUpdate).toBeTruthy();
    expect(res.body.nextUpdate).toBeTruthy();
  });

  it('returns empty revokedCertificates when nothing is revoked', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(activeCred);

    const res = await request(app).get('/api/credentials/crl');
    expect(res.status).toBe(200);
    expect(res.body.totalRevoked).toBe(0);
    expect(res.body.revokedCertificates).toHaveLength(0);
  });

  it('returns PEM envelope when format=pem', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(revokedCred);

    const res = await request(app).get('/api/credentials/crl?format=pem');
    expect(res.status).toBe(200);
    expect(res.text).toContain('-----BEGIN X509 CRL-----');
    expect(res.text).toContain('-----END X509 CRL-----');
  });

  it('accepts custom issuer name', async () => {
    mockSimulateCall.mockResolvedValueOnce(0n);

    const res = await request(app).get('/api/credentials/crl?issuer=MyOrg');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe('MyOrg');
  });

  it('returns 400 for unsupported format', async () => {
    const res = await request(app).get('/api/credentials/crl?format=der');
    expect(res.status).toBe(400);
  });
});
