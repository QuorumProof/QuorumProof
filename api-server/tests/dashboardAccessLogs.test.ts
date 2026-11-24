import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { DashboardAccessLogStore } from '../src/services/dashboardAccessLogs.js';

function mockPool(): Pool {
  return {
    query: vi.fn(),
  } as unknown as Pool;
}

describe('DashboardAccessLogStore', () => {
  it('uses the configured retention window and records durable rows', async () => {
    const pool = mockPool();
    const query = vi.mocked(pool.query);
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({
        rows: [{
          credential_id: '7',
          accessed_by: 'GBTEST',
          accessed_at: new Date('2026-11-24T20:00:00.000Z'),
          reason: 'verification',
          duration_seconds: 12,
        }],
        rowCount: 1,
      });

    const store = new DashboardAccessLogStore(() => pool, 30);
    const entry = await store.record({
      credential_id: '7',
      accessed_by: 'GBTEST',
      accessed_at: '2026-11-24T20:00:00.000Z',
      reason: 'verification',
      duration_seconds: 12,
    });

    expect(store.retentionDays).toBe(30);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('DELETE FROM dashboard_access_logs'),
      [30]
    );
    expect(entry.credential_id).toBe('7');
  });

  it('lists owned credentials with filtering and pagination', async () => {
    const pool = mockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{
        credential_id: '7',
        accessed_by: 'GBTEST',
        accessed_at: new Date('2026-11-24T20:00:00.000Z'),
        reason: 'verification',
        duration_seconds: 12,
        total: '1',
      }],
      rowCount: 1,
    });

    const store = new DashboardAccessLogStore(() => pool, 90);
    const result = await store.list({
      credentialIds: ['7', '8'],
      credentialId: '7',
      from: new Date('2026-11-01T00:00:00.000Z'),
      limit: 100,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].accessed_at).toBe('2026-11-24T20:00:00.000Z');
  });
});
