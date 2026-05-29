import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSlicesRouter } from '../src/routes/slices.js';

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as unknown as ReturnType<typeof mockSimulateCall>,
};

const app = express();
app.use(express.json());
app.use('/api/slices', createSlicesRouter(mockSoroban));

const mockSlice = {
  id: 1n,
  creator: 'GABC',
  attestors: ['GATT1', 'GATT2'],
  weights: [1, 1],
  threshold: 1,
};

describe('GET /api/slices/:id', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns a slice by ID', async () => {
    mockSimulateCall.mockResolvedValueOnce(mockSlice);
    const res = await request(app).get('/api/slices/1');
    expect(res.status).toBe(200);
    expect(res.body.creator).toBe('GABC');
  });

  it('returns 404 when slice not found', async () => {
    mockSimulateCall.mockRejectedValueOnce(new Error('SliceNotFound'));
    const res = await request(app).get('/api/slices/999');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid ID', async () => {
    const res = await request(app).get('/api/slices/abc');
    expect(res.status).toBe(400);
  });

  it('returns 400 for zero ID', async () => {
    const res = await request(app).get('/api/slices/0');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/slices', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns paginated slices', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(2n) // get_slice_count
      .mockResolvedValueOnce({ ...mockSlice, id: 1n })
      .mockResolvedValueOnce({ ...mockSlice, id: 2n });

    const res = await request(app).get('/api/slices?page=1&page_size=20');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(2);
  });

  it('returns empty list when no slices exist', async () => {
    mockSimulateCall.mockResolvedValueOnce(0n);
    const res = await request(app).get('/api/slices');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('respects page_size limit', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(5n)
      .mockResolvedValueOnce({ ...mockSlice, id: 1n })
      .mockResolvedValueOnce({ ...mockSlice, id: 2n });

    const res = await request(app).get('/api/slices?page=1&page_size=2');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.page_size).toBe(2);
  });
});
