import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import atomicSwapRouter from '../src/routes/atomicSwap.js';

const app = express();
app.use(express.json());
app.use('/atomic-swap', atomicSwapRouter);

describe('atomic swap route validation', () => {
  it.each([
    ['/initiate', { initiator_address: 'G123', responder_address: 'G456', initiator_credential_id: 'invalid', responder_credential_id: 2 }],
    ['/swap-1/lock', { participant_address: {} }],
    ['/%20/lock', { participant_address: 'G123' }],
    ['/swap-1/complete', { initiator_signature: 'sig-1' }],
    ['/swap-1/cancel', { canceller_address: {} }],
  ])('rejects invalid input for %s', async (path, body) => {
    const response = await request(app).post(`/atomic-swap${path}`).send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });
});
