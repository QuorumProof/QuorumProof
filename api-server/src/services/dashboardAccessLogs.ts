import type { Pool } from 'pg';
import { getPool } from '../db.js';

export interface DashboardAccessLog {
  credential_id: string;
  accessed_by: string;
  accessed_at: string;
  reason: string;
  duration_seconds: number;
}

interface DashboardAccessLogRow {
  credential_id: string;
  accessed_by: string;
  accessed_at: string | Date;
  reason: string;
  duration_seconds: number;
}

export interface DashboardAccessLogFilters {
  credentialIds: string[];
  credentialId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

function configuredRetentionDays(): number {
  const parsed = Number.parseInt(process.env.DASHBOARD_ACCESS_LOG_RETENTION_DAYS ?? '90', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 90;
}

function mapRow(row: DashboardAccessLogRow): DashboardAccessLog {
  return {
    credential_id: row.credential_id,
    accessed_by: row.accessed_by,
    accessed_at: row.accessed_at instanceof Date
      ? row.accessed_at.toISOString()
      : new Date(row.accessed_at).toISOString(),
    reason: row.reason,
    duration_seconds: row.duration_seconds,
  };
}

export class DashboardAccessLogStore {
  readonly retentionDays: number;

  constructor(
    private readonly poolResolver: () => Pool = getPool,
    retentionDays = configuredRetentionDays()
  ) {
    this.retentionDays = retentionDays;
  }

  private get pool(): Pool {
    return this.poolResolver();
  }

  async purgeExpired(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM dashboard_access_logs
       WHERE accessed_at < now() - ($1 * interval '1 day')`,
      [this.retentionDays]
    );
    return result.rowCount ?? 0;
  }

  async record(entry: DashboardAccessLog): Promise<DashboardAccessLog> {
    await this.purgeExpired();
    const result = await this.pool.query<DashboardAccessLogRow>(
      `INSERT INTO dashboard_access_logs
       (credential_id, accessed_by, accessed_at, reason, duration_seconds)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING credential_id, accessed_by, accessed_at, reason, duration_seconds`,
      [entry.credential_id, entry.accessed_by, entry.accessed_at, entry.reason, entry.duration_seconds]
    );
    return mapRow(result.rows[0]);
  }

  async list(filters: DashboardAccessLogFilters): Promise<{ logs: DashboardAccessLog[]; total: number }> {
    if (filters.credentialIds.length === 0) {
      return { logs: [], total: 0 };
    }

    const params: unknown[] = [filters.credentialIds];
    const conditions = ['credential_id = ANY($1::varchar[])'];
    if (filters.credentialId) {
      params.push(filters.credentialId);
      conditions.push(`credential_id = $${params.length}`);
    }
    if (filters.from) {
      params.push(filters.from);
      conditions.push(`accessed_at >= $${params.length}`);
    }
    if (filters.to) {
      params.push(filters.to);
      conditions.push(`accessed_at <= $${params.length}`);
    }

    params.push(filters.limit, filters.offset);
    const limitParam = params.length - 1;
    const offsetParam = params.length;
    const result = await this.pool.query<DashboardAccessLogRow & { total: string }>(
      `SELECT credential_id, accessed_by, accessed_at, reason, duration_seconds,
              count(*) OVER()::text AS total
       FROM dashboard_access_logs
       WHERE ${conditions.join(' AND ')}
       ORDER BY accessed_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params
    );

    return {
      logs: result.rows.map(mapRow),
      total: result.rows.length > 0 ? Number.parseInt(result.rows[0].total, 10) : 0,
    };
  }

  async forCredentials(credentialIds: string[]): Promise<DashboardAccessLog[]> {
    if (credentialIds.length === 0) return [];
    const result = await this.pool.query<DashboardAccessLogRow>(
      `SELECT credential_id, accessed_by, accessed_at, reason, duration_seconds
       FROM dashboard_access_logs
       WHERE credential_id = ANY($1::varchar[])
       ORDER BY accessed_at DESC`,
      [credentialIds]
    );
    return result.rows.map(mapRow);
  }

  async countCredential(credentialId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM dashboard_access_logs WHERE credential_id = $1',
      [credentialId]
    );
    return Number.parseInt(result.rows[0]?.count ?? '0', 10);
  }
}

let defaultStore: DashboardAccessLogStore | undefined;

export function getDefaultDashboardAccessLogStore(): DashboardAccessLogStore {
  if (!defaultStore) defaultStore = new DashboardAccessLogStore();
  return defaultStore;
}

export function _setDefaultDashboardAccessLogStoreForTest(store?: DashboardAccessLogStore): void {
  defaultStore = store;
}
