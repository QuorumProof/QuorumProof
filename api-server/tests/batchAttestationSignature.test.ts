import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import attestorRouter from '../src/routes/attestor.js';
import { buildBatchAttestationMessage, verifyBatchAttestationSignature } from '../src/services/batchAttestationSignature.js';

describe('batch attestation signatures', () => {
  it('verifies a signature bound to the attestor, slice, and credential list', () => {
    const attestor = Keypair.random();
    const message = buildBatchAttestationMessage(attestor.publicKey(), '8', ['10', '11']);
    const signature = attestor.sign(Buffer.from(message, 'utf8')).toString('hex');

    expect(verifyBatchAttestationSignature(attestor.publicKey(), '8', ['10', '11'], signature).valid).toBe(true);
    expect(verifyBatchAttestationSignature(attestor.publicKey(), '9', ['10', '11'], signature).valid).toBe(false);
    expect(verifyBatchAttestationSignature(attestor.publicKey(), '8', ['10', '12'], signature).valid).toBe(false);
  });

  it('rejects batch requests without an attestor signature', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/attestor', attestorRouter);

    const response = await request(app)
      .post('/api/attestor/batch-attest')
      .send({ attestor: Keypair.random().publicKey(), credential_ids: ['1'], slice_id: '1' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('signature are required');
  });
});
