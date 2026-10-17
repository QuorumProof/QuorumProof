import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/services/graphqlResolvers.js', () => ({
  GraphQLResolvers: class {},
}));

import { createBulkOperationsRouter } from '../src/routes/bulkOperations.js';

describe('POST /api/bulk authentication', () => {
  it('rejects unauthenticated bulk requests before dispatching operations', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/bulk', createBulkOperationsRouter({
      simulateCall: async () => null,
      u64Val: (value) => value,
      u32Val: (value) => value,
      addressVal: (value) => value,
    }));

    const response = await request(app)
      .post('/api/bulk')
      .send({ operations: [{ type: 'credential', args: { id: '1' } }] });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Authentication required');
  });
});
