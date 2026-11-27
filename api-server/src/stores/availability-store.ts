import type { Pool } from "pg"; // ADAPT: or your project's DB type

// ADAPT: replace with the real record type used in attestors.ts
export type AvailabilityRecord = Record<string, unknown>;

export interface AvailabilityStore {
  get(attestorId: string): Promise<AvailabilityRecord | undefined>;
  set(attestorId: string, record: AvailabilityRecord): Promise<void>;
  list(): Promise<Array<{ attestorId: string; record: AvailabilityRecord }>>;
  delete(attestorId: string): Promise<boolean>;
}

/** Durable store, survives restarts. */
export class PostgresAvailabilityStore implements AvailabilityStore {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS attestor_availability (
        attestor_id TEXT PRIMARY KEY,
        record      JSONB NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
  }

  async get(attestorId: string) {
    const { rows } = await this.pool.query(
      "SELECT record FROM attestor_availability WHERE attestor_id = $1",
      [attestorId],
    );
    return rows[0]?.record as AvailabilityRecord | undefined;
  }

  async set(attestorId: string, record: AvailabilityRecord) {
    await this.pool.query(
      `INSERT INTO attestor_availability (attestor_id, record, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (attestor_id)
       DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
      [attestorId, JSON.stringify(record)],
    );
  }

  async list() {
    const { rows } = await this.pool.query(
      "SELECT attestor_id, record FROM attestor_availability ORDER BY attestor_id",
    );
    return rows.map((r) => ({ attestorId: r.attestor_id as string, record: r.record as AvailabilityRecord }));
  }

  async delete(attestorId: string) {
    const res = await this.pool.query(
      "DELETE FROM attestor_availability WHERE attestor_id = $1",
      [attestorId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

/** In-memory store: kept for unit tests and for running without a database. */
export class MemoryAvailabilityStore implements AvailabilityStore {
  private readonly map = new Map<string, AvailabilityRecord>();
  async get(id: string) { return this.map.get(id); }
  async set(id: string, record: AvailabilityRecord) { this.map.set(id, record); }
  async list() { return [...this.map].map(([attestorId, record]) => ({ attestorId, record })); }
  async delete(id: string) { return this.map.delete(id); }
}
