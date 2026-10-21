import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import attestorRouter from '../src/routes/attestor.js';
import * as soroban from '../src/soroban.js';
import { metricsStore } from '../src/services/metrics.js';

vi.mock('../src/soroban.js', () => ({
  prepareCalls: vi.fn(async () => ({
    transaction_xdr: 'prepared-xdr',
    network_passphrase: 'Test SDF Network ; September 2015',
  })),
  simulateCall: vi.fn(),
  u64Val: (n: number | bigint) => n,
  addressVal: (address: string) => address,
}));

describe('POST /api/attestor/batch-attest', () => {
  const mockPrepareCalls = vi.mocked(soroban.prepareCalls);
  const mockSimulateCall = vi.mocked(soroban.simulateCall);
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/attestor', attestorRouter);
  });

  it('returns wallet-signable attestations without claiming they were recorded', async () => {
    const recordEvent = vi.spyOn(metricsStore, 'recordEvent');
    const res = await request(app).post('/api/attestor/batch-attest').send({
      attestor: 'GATTESTOR',
      credential_ids: ['12', '13'],
      slice_id: '4',
    });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      total: 2,
      succeeded: 0,
      failed: 0,
      pending: 2,
      transaction_xdr: 'prepared-xdr',
    });
    expect(res.body.results).toEqual([
      { credential_id: '12', status: 'pending_signature' },
      { credential_id: '13', status: 'pending_signature' },
    ]);
    expect(mockPrepareCalls).toHaveBeenCalledWith('GATTESTOR', [
      { method: 'attest_credential', args: [12n, 4n, 'GATTESTOR'] },
      { method: 'attest_credential', args: [13n, 4n, 'GATTESTOR'] },
    ]);
    expect(mockSimulateCall).not.toHaveBeenCalledWith('attest_credential', expect.anything());
    expect(recordEvent).not.toHaveBeenCalled();
    recordEvent.mockRestore();
  });

  it('rejects invalid credential identifiers before preparing a transaction', async () => {
    const res = await request(app).post('/api/attestor/batch-attest').send({
      attestor: 'GATTESTOR',
      credential_ids: ['not-an-id'],
      slice_id: '4',
    });

    expect(res.status).toBe(400);
    expect(mockPrepareCalls).not.toHaveBeenCalled();
  });
});
