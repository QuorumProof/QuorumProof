import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createBulkOperationsRouter } from '../src/routes/bulkOperations.js';
import type { SorobanClient } from '../src/services/graphqlResolvers.js';

vi.mock('../src/db.js', () => ({
  getPool: () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
}));

function createTestApp() {
  const simulateCall = vi.fn();
  const soroban = {
    simulateCall,
    u64Val: (value: number | bigint) => value,
    u32Val: (value: number) => value,
    addressVal: (value: string) => value,
  } as unknown as SorobanClient;
  const app = express();
  app.use(express.json());
  app.use('/api/bulk', createBulkOperationsRouter(soroban));
  return { app, simulateCall };
}

describe('bulk operations route', () => {
  it('rejects an empty or missing operation list', async () => {
    const { app, simulateCall } = createTestApp();
    expect((await request(app).post('/api/bulk').send({})).status).toBe(400);
    expect((await request(app).post('/api/bulk').send({ operations: [] })).status).toBe(400);
    expect(simulateCall).not.toHaveBeenCalled();
  });

  it('enforces the 50-operation maximum without resolving any operations', async () => {
    const { app, simulateCall } = createTestApp();
    const operations = Array.from({ length: 51 }, (_, id) => ({
      type: 'slice',
      args: { id: id + 1 },
    }));
    const response = await request(app).post('/api/bulk').send({ operations });

    expect(response.status).toBe(413);
    expect(response.body.error).toBe('operations cannot exceed 50 items');
    expect(simulateCall).not.toHaveBeenCalled();
  });

  it('returns ordered per-operation results, IDs, and partial-failure summary', async () => {
    const { app, simulateCall } = createTestApp();
    simulateCall
      .mockResolvedValueOnce({ id: 1, creator: 'GCREATOR' })
      .mockRejectedValueOnce(new Error('contract unavailable'));
    const response = await request(app).post('/api/bulk').send({
      operations: [
        { id: 'first', type: 'slice', args: { id: 1 } },
        { id: 'invalid', args: {} },
        { id: 'third', type: 'slice', args: { id: 3 } },
      ],
    });

    expect(response.status).toBe(207);
    expect(response.body.results).toEqual([
      { id: 'first', ok: true, data: { id: 1, creator: 'GCREATOR' } },
      { id: 'invalid', ok: false, error: 'type is required' },
      { id: 'third', ok: false, error: 'contract unavailable' },
    ]);
    expect(response.body.summary).toEqual({ total: 3, succeeded: 1, failed: 2 });
    expect(simulateCall).toHaveBeenCalledTimes(2);
  });

  it('accepts exactly 50 operations and returns a success summary', async () => {
    const { app, simulateCall } = createTestApp();
    simulateCall.mockImplementation(async (_method: string, [id]: unknown[]) => ({ id }));
    const operations = Array.from({ length: 50 }, (_, id) => ({
      type: 'slice',
      args: { id: id + 1 },
    }));
    const response = await request(app).post('/api/bulk').send({ operations });

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ total: 50, succeeded: 50, failed: 0 });
    expect(response.body.results).toHaveLength(50);
    expect(simulateCall).toHaveBeenCalledTimes(50);
  });
});
