import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { submitCall, recordEvent } = vi.hoisted(() => ({
  submitCall: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock('../src/soroban.js', () => ({
  simulateCall: vi.fn(),
  submitCall,
  u64Val: (value: number | bigint) => value,
  addressVal: (value: string) => value,
}));

vi.mock('../src/services/metrics.js', () => ({
  metricsStore: { recordEvent },
}));

import attestorRouter from '../src/routes/attestor.js';

describe('POST /api/attestor/batch-attest transaction confirmation', () => {
  beforeEach(() => {
    submitCall.mockReset().mockResolvedValue({
      status: 'confirmed',
      transaction_hash: 'confirmed-attestation-hash',
      result: null,
    });
    recordEvent.mockReset();
  });

  it('returns caller authorization data without claiming an attestation', async () => {
    submitCall.mockResolvedValueOnce({
      status: 'prepared',
      transaction_xdr: 'unsigned-attestation-xdr',
      authorization_entries_xdr: ['unsigned-attestation-auth-xdr'],
    });
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api/attestor', attestorRouter);

    const response = await request(testApp)
      .post('/api/attestor/batch-attest')
      .send({ attestor: 'GATTESTOR', credential_ids: ['5'], slice_id: '2' });

    expect(response.status).toBe(428);
    expect(response.body.succeeded).toBe(0);
    expect(response.body.results[0]).toMatchObject({
      success: false,
      status: 'authorization_required',
      transaction_xdr: 'unsigned-attestation-xdr',
    });
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('records metrics only after the caller-signed transaction is confirmed', async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api/attestor', attestorRouter);

    const response = await request(testApp)
      .post('/api/attestor/batch-attest')
      .send({
        attestor: 'GATTESTOR',
        credential_ids: ['5'],
        slice_id: '2',
        signed_transactions: { '5': 'signed-attestation-xdr' },
      });

    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({
      success: true,
      status: 'confirmed',
      transaction_hash: 'confirmed-attestation-hash',
    });
    expect(submitCall).toHaveBeenCalledWith('attest_credential', [5n, 2n, 'GATTESTOR'], 'signed-attestation-xdr');
    expect(recordEvent).toHaveBeenCalledOnce();
  });

  it('does not record success metrics while confirmation is pending', async () => {
    submitCall.mockResolvedValueOnce({
      status: 'pending',
      transaction_hash: 'pending-attestation-hash',
    });
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api/attestor', attestorRouter);

    const response = await request(testApp)
      .post('/api/attestor/batch-attest')
      .send({ attestor: 'GATTESTOR', credential_ids: ['5'], slice_id: '2' });

    expect(response.status).toBe(202);
    expect(response.body.succeeded).toBe(0);
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
