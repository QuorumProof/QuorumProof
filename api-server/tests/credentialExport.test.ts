import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCredentialExportRouter } from '../src/routes/credentialExport.js';
import type { SorobanClient } from '../src/routes/credentials.js';

const credential = {
  id: 15n,
  subject: 'GHOLDER',
  issuer: 'GISSUER',
  credential_type: 2,
  metadata_hash: 'hash-15',
  metadata: { serial: 123n },
  revoked: false,
  suspended: false,
  expires_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  version: 1,
};

function createTestApp() {
  const simulateCall = vi.fn().mockResolvedValue(credential);
  const soroban = {
    simulateCall,
    u64Val: (value: number | bigint) => value,
    u32Val: (value: number) => value,
    addressVal: (value: string) => value,
  } as unknown as SorobanClient;
  const app = express();
  app.use('/api/credentials', createCredentialExportRouter(soroban));
  return { app, simulateCall };
}

describe('credential export routes', () => {
  beforeEach(() => {
    vi.stubEnv('PUBLIC_APP_BASE_URL', 'https://verify.example.test/');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns JSON with recursively serialized bigints and a verification URL', async () => {
    const { app, simulateCall } = createTestApp();
    const response = await request(app).get('/api/credentials/15/export');

    expect(response.status).toBe(200);
    expect(response.body.credential).toMatchObject({ id: '15', metadata: { serial: '123' } });
    expect(response.body.verification_url).toBe('https://verify.example.test/api/verify/15');
    expect(response.body.exported_at).toEqual(expect.any(String));
    expect(simulateCall).toHaveBeenCalledWith('get_credential', [15]);
  });

  it('returns a PDF attachment containing the credential export', async () => {
    const { app } = createTestApp();
    const response = await request(app).get('/api/credentials/15/export?format=pdf');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/pdf/);
    expect(response.headers['content-disposition']).toBe('attachment; filename="credential-15.pdf"');
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect((response.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('returns a PNG QR code for the verification URL', async () => {
    const { app } = createTestApp();
    const response = await request(app).get('/api/credentials/15/export?format=qrcode');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/image\/png/);
    expect(response.headers['content-disposition']).toBe('inline; filename="credential-15-qrcode.png"');
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect((response.body as Buffer).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('validates IDs and formats and maps missing credentials to 404', async () => {
    const { app, simulateCall } = createTestApp();
    expect((await request(app).get('/api/credentials/0/export')).status).toBe(400);
    expect((await request(app).get('/api/credentials/15/export?format=xml')).status).toBe(400);

    simulateCall.mockRejectedValueOnce(new Error('CredentialNotFound'));
    const missing = await request(app).get('/api/credentials/15/export');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('Credential not found');
  });
});
