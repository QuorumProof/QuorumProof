import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuditRouter } from '../src/routes/audit.js';

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as unknown as ReturnType<typeof mockSimulateCall>,
  u32Val: (n: number) => n as unknown as ReturnType<typeof mockSimulateCall>,
};

const app = express();
app.use(express.json());
app.use('/api/audit', createAuditRouter(mockSoroban));

const mockEntry = {
  id: 1n,
  action: 1, // CredentialIssued
  credential_id: 42n,
  actor: 'GACTOR1',
  timestamp: 1700000000n,
  ledger_sequence: 100,
  payload_hash: 'aabbcc',
};

const mockNotarization = {
  batch_id: 1n,
  merkle_root: 'deadbeef',
  entry_count: 2,
  first_entry_id: 1n,
  last_entry_id: 2n,
  notarized_at: 1700000000n,
  notarized_ledger: 100,
};

describe('GET /api/audit/entries', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns paginated entries', async () => {
    mockSimulateCall
      .mockResolvedValueOnce([mockEntry, { ...mockEntry, id: 2n }])
      .mockResolvedValueOnce(2n);

    const res = await request(app).get('/api/audit/entries');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe('2');
  });

  it('filters by credential_id', async () => {
    mockSimulateCall.mockResolvedValueOnce([mockEntry]);

    const res = await request(app).get('/api/audit/entries?credential_id=42');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(mockSimulateCall).toHaveBeenCalledWith('get_entries_for_credential', expect.anything());
  });

  it('filters by action', async () => {
    mockSimulateCall.mockResolvedValueOnce([mockEntry]);

    const res = await request(app).get('/api/audit/entries?action=CredentialIssued');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(mockSimulateCall).toHaveBeenCalledWith('get_entries_by_action', expect.anything());
  });

  it('returns 400 for unknown action', async () => {
    const res = await request(app).get('/api/audit/entries?action=UnknownAction');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unknown action');
  });

  it('returns 500 on contract error', async () => {
    mockSimulateCall.mockRejectedValueOnce(new Error('contract error'));
    const res = await request(app).get('/api/audit/entries');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/audit/entries/:id', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns an entry by id', async () => {
    mockSimulateCall.mockResolvedValueOnce(mockEntry);
    const res = await request(app).get('/api/audit/entries/1');
    expect(res.status).toBe(200);
    expect(res.body.credential_id).toBe('42');
  });

  it('returns 404 for missing entry', async () => {
    mockSimulateCall.mockRejectedValueOnce(new Error('EntryNotFound'));
    const res = await request(app).get('/api/audit/entries/999');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid id', async () => {
    const res = await request(app).get('/api/audit/entries/abc');
    expect(res.status).toBe(400);
  });

  it('returns 400 for id zero', async () => {
    const res = await request(app).get('/api/audit/entries/0');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/audit/notarizations/:batch_id', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns a notarization by batch_id', async () => {
    mockSimulateCall.mockResolvedValueOnce(mockNotarization);
    const res = await request(app).get('/api/audit/notarizations/1');
    expect(res.status).toBe(200);
    expect(res.body.merkle_root).toBe('deadbeef');
  });

  it('returns 404 for missing notarization', async () => {
    mockSimulateCall.mockRejectedValueOnce(new Error('EntryNotFound'));
    const res = await request(app).get('/api/audit/notarizations/99');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid batch_id', async () => {
    const res = await request(app).get('/api/audit/notarizations/0');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/audit/stats', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns entry and batch counts', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(5n)
      .mockResolvedValueOnce(2n);

    const res = await request(app).get('/api/audit/stats');
    expect(res.status).toBe(200);
    expect(res.body.entry_count).toBe('5');
    expect(res.body.batch_count).toBe('2');
  });

  it('returns 500 on error', async () => {
    mockSimulateCall.mockRejectedValueOnce(new Error('rpc error'));
    const res = await request(app).get('/api/audit/stats');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/audit/export', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('exports audit logs in JSON Lines format by default', async () => {
    mockSimulateCall.mockResolvedValueOnce([mockEntry]);

    const res = await request(app).get('/api/audit/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.text).toContain('CredentialIssued');
  });

  it('exports audit logs in JSON format', async () => {
    mockSimulateCall.mockResolvedValueOnce([mockEntry]);

    const res = await request(app).get('/api/audit/export?format=json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('filters export by credential_id', async () => {
    mockSimulateCall.mockResolvedValueOnce([mockEntry]);

    const res = await request(app).get('/api/audit/export?credential_id=42');
    expect(res.status).toBe(200);
    expect(mockSimulateCall).toHaveBeenCalledWith('get_entries_for_credential', expect.anything());
  });

  it('filters export by action', async () => {
    mockSimulateCall.mockResolvedValueOnce([mockEntry]);

    const res = await request(app).get('/api/audit/export?action=CredentialIssued');
    expect(res.status).toBe(200);
    expect(mockSimulateCall).toHaveBeenCalledWith('get_entries_by_action', expect.anything());
  });
});

describe('POST /api/audit/verify', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('verifies Merkle root integrity', async () => {
    const entry1 = { ...mockEntry, id: 1n };
    const entry2 = { ...mockEntry, id: 2n, payload_hash: 'ccddee' };

    mockSimulateCall
      .mockResolvedValueOnce(mockNotarization)
      .mockResolvedValueOnce([entry1, entry2]);

    const res = await request(app)
      .post('/api/audit/verify')
      .send({ batch_id: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('batch_id', 1);
    expect(res.body).toHaveProperty('valid');
    expect(res.body).toHaveProperty('merkle_root');
    expect(res.body).toHaveProperty('entry_count');
  });

  it('returns 400 for invalid batch_id', async () => {
    const res = await request(app)
      .post('/api/audit/verify')
      .send({ batch_id: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Validation failed');
  });

  it('returns 500 on contract error', async () => {
    mockSimulateCall.mockRejectedValueOnce(new Error('batch not found'));

    const res = await request(app)
      .post('/api/audit/verify')
      .send({ batch_id: 999 });

    expect(res.status).toBe(500);
  });
});
