import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createShareLinksRouter } from '../src/routes/shareLinks.js';
import * as soroban from '../src/soroban.js';

vi.mock('../src/soroban.js', () => ({
  prepareCall: vi.fn(async () => ({
    transaction_xdr: 'prepared-xdr',
    network_passphrase: 'Test SDF Network ; September 2015',
  })),
  simulateCall: vi.fn(),
  u64Val: (n: number | bigint) => n,
  u32Val: (n: number) => n,
  addressVal: (address: string) => address,
}));

describe('Share link write routes', () => {
  const mockPrepareCall = vi.mocked(soroban.prepareCall);
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/credentials', createShareLinksRouter({
      simulateCall: soroban.simulateCall,
      u64Val: soroban.u64Val,
      u32Val: soroban.u32Val,
      addressVal: soroban.addressVal,
    }));
  });

  it('prepares share-link creation without returning a usable token', async () => {
    const res = await request(app).post('/api/credentials/42/share').send({
      subject: 'GSHAREHOLDER',
      expiry_hours: 24,
      permission: 'view_only',
    });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending_signature');
    expect(res.body.transaction_xdr).toBe('prepared-xdr');
    expect(res.body.token).toBeUndefined();
    expect(res.body.expires_at).toBeUndefined();
    expect(mockPrepareCall).toHaveBeenCalledWith('GSHAREHOLDER', 'generate_share_link', expect.any(Array));
  });

  it('prepares share-link revocation without reporting it revoked', async () => {
    const token = 'ab'.repeat(16);
    const res = await request(app)
      .delete(`/api/credentials/share/${token}`)
      .send({ subject: 'GSHAREHOLDER' });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending_signature');
    expect(res.body.transaction_xdr).toBe('prepared-xdr');
    expect(res.body.success).not.toBe(true);
    expect(mockPrepareCall).toHaveBeenCalledWith('GSHAREHOLDER', 'revoke_share_link', expect.any(Array));
  });
});
