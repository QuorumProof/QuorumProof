import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import distributedRevocationRegistryRouter from '../src/routes/distributedRevocationRegistry.js';

const app = express();
app.use(express.json());
app.use('/distributed-revocation', distributedRevocationRegistryRouter);

describe('distributed revocation route validation', () => {
  it.each([
    ['/revoke', { credential_id: 'invalid', revoked_by: 'issuer-1' }],
    ['/revoke', { credential_id: 1, revoked_by: 'issuer-1', locked_until: 'not-a-date' }],
    ['/peer/register', { peer_id: 'peer-1', peer_address: {} }],
    ['/peer/%20/unreachable', {}],
    ['/peer/%20/reachable', {}],
    ['/sync/%20', {}],
    ['/commit', { unexpected: true }],
  ])('rejects invalid input for %s', async (path, body) => {
    const response = await request(app).post(`/distributed-revocation${path}`).send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });

  it('allows the bodyless commit operation', async () => {
    const response = await request(app).post('/distributed-revocation/commit');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});
