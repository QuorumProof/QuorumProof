/**
 * Durable storage for webhook registrations and deliveries — Issue #926 / #1433
 *
 * Storage: Postgres-backed (webhook_registrations + webhook_deliveries tables)
 * when a pool is available. Falls back to the original append-only JSONL WAL
 * (DurableLog) in test environments where no pool is initialised, preserving
 * all existing test contracts.
 *
 * The WebhookCircuitBreaker uses its own DurableLog for state and is
 * intentionally left unchanged — its state is a local operational concern,
 * not a shared registration record.
 */

import crypto from 'crypto';
import path from 'path';
import { DurableLog } from './durableLog.js';
import { getPool } from '../db.js';
import type { Pool as PgPool } from 'pg';

export type WebhookEvent = 'credential_issued' | 'credential_attested' | 'credential_revoked';

export interface WebhookRegistration {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret?: string;
  createdAt: string;
}

export interface WebhookPayload {
  event: string;
  credential_id: number;
  issuer?: string;
  holder?: string;
  attestor?: string;
  timestamp: string;
}

export type DeliveryStatus = 'pending' | 'success' | 'dead_letter';

export interface DeliveryRecord {
  /** Stable idempotency key, sent as X-QuorumProof-Delivery-Id on every attempt for this delivery. */
  id: string;
  webhookId: string;
  credentialId: number;
  event: string;
  payload: WebhookPayload;
  /** Ordering partition: deliveries sharing an orderKey are delivered strictly in `sequence` order. */
  orderKey: string;
  sequence: number;
  status: DeliveryStatus;
  attempts: number;
  lastAttemptAt?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export function orderKeyFor(webhookId: string, credentialId: number): string {
  return `${webhookId}:${credentialId}`;
}

export interface WebhookStoreOptions {
  /** Postgres pool to use (takes precedence over the global singleton). */
  pool?: PgPool;
  /** Legacy: path to a directory for DurableLog files (used in fallback mode). */
  dataDir?: string;
}

const REG_ID_PATTERN = /^wh_(\d+)$/;
const DELIVERY_ID_PATTERN = /^dlv_(\d+)$/;

// ---------------------------------------------------------------------------
// Dual-mode pool helper
// ---------------------------------------------------------------------------

/** Returns the Postgres pool if initialised, or null for in-memory fallback. */
function getPoolSafe(): PgPool | null {
  try {
    return getPool();
  } catch {
    return null;
  }
}

/** Generate a short random suffix for IDs when using Postgres. */
function randomSuffix(): string {
  return crypto.randomBytes(4).toString('hex');
}

// ---------------------------------------------------------------------------
// Row → domain-object mappers
// ---------------------------------------------------------------------------

function rowToRegistration(row: {
  id: string; url: string; events: string[];
  secret: string | null; created_at: Date | string;
}): WebhookRegistration {
  return {
    id: row.id,
    url: row.url,
    events: row.events as WebhookEvent[],
    secret: row.secret ?? undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function rowToDelivery(row: {
  id: string; webhook_id: string; credential_id: number; event: string;
  payload: WebhookPayload; order_key: string; sequence: number; status: string;
  attempts: number; last_attempt_at: Date | string | null; error: string | null;
  created_at: Date | string; completed_at: Date | string | null;
}): DeliveryRecord {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    credentialId: row.credential_id,
    event: row.event,
    payload: row.payload,
    orderKey: row.order_key,
    sequence: row.sequence,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at
      ? (row.last_attempt_at instanceof Date ? row.last_attempt_at.toISOString() : String(row.last_attempt_at))
      : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    completedAt: row.completed_at
      ? (row.completed_at instanceof Date ? row.completed_at.toISOString() : String(row.completed_at))
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// WebhookStore
// ---------------------------------------------------------------------------

export class WebhookStore {
  readonly dataDir: string;
  /** DurableLog stores — only used when no Postgres pool is available. */
  private readonly _regLog: DurableLog<WebhookRegistration>;
  private readonly _delLog: DurableLog<DeliveryRecord>;
  /** Explicit pool override (from constructor options). */
  private readonly _pool: PgPool | undefined;

  // Counters used in DurableLog fallback mode only
  private regCounter: number;
  private deliveryCounter: number;
  private readonly sequenceCounters = new Map<string, number>();

  constructor(options: WebhookStoreOptions = {}) {
    const dataDir =
      options.dataDir ??
      process.env.WEBHOOK_STORE_DATA_DIR ??
      path.join(process.cwd(), '.data', 'webhooks');
    this.dataDir = dataDir;
    this._pool = options.pool;

    this._regLog = new DurableLog<WebhookRegistration>(
      path.join(dataDir, 'registrations.jsonl')
    );
    this._delLog = new DurableLog<DeliveryRecord>(path.join(dataDir, 'deliveries.jsonl'));

    // Recover counters from DurableLog (only matters in fallback mode)
    this.regCounter = this.recoverCounter(this._regLog.keys(), REG_ID_PATTERN);
    this.deliveryCounter = this.recoverCounter(this._delLog.keys(), DELIVERY_ID_PATTERN);
    for (const rec of this._delLog.values()) {
      const cur = this.sequenceCounters.get(rec.orderKey) ?? 0;
      if (rec.sequence > cur) this.sequenceCounters.set(rec.orderKey, rec.sequence);
    }
  }

  private pool(): PgPool | null {
    return this._pool ?? getPoolSafe();
  }

  private recoverCounter(keys: string[], pattern: RegExp): number {
    let max = 0;
    for (const key of keys) {
      const match = pattern.exec(key);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return max;
  }

  // ── Registrations ────────────────────────────────────────────────────────

  async registerWebhook(url: string, events: WebhookEvent[], secret?: string): Promise<WebhookRegistration> {
    const pool = this.pool();
    if (pool) {
      const id = `wh_${Date.now()}_${randomSuffix()}`;
      const createdAt = new Date().toISOString();
      await pool.query(
        `INSERT INTO webhook_registrations (id, url, events, secret, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, url, events, secret ?? null, createdAt]
      );
      return { id, url, events, secret, createdAt };
    }

    // DurableLog fallback
    this.regCounter += 1;
    const reg: WebhookRegistration = {
      id: `wh_${this.regCounter}`,
      url,
      events,
      secret,
      createdAt: new Date().toISOString(),
    };
    this._regLog.set(reg.id, reg);
    return reg;
  }

  async listWebhooks(): Promise<WebhookRegistration[]> {
    const pool = this.pool();
    if (pool) {
      const result = await pool.query<{
        id: string; url: string; events: string[];
        secret: string | null; created_at: Date;
      }>('SELECT id, url, events, secret, created_at FROM webhook_registrations ORDER BY created_at ASC');
      return result.rows.map(rowToRegistration);
    }
    return this._regLog.values();
  }

  async getWebhook(id: string): Promise<WebhookRegistration | undefined> {
    const pool = this.pool();
    if (pool) {
      const result = await pool.query<{
        id: string; url: string; events: string[];
        secret: string | null; created_at: Date;
      }>(
        'SELECT id, url, events, secret, created_at FROM webhook_registrations WHERE id = $1',
        [id]
      );
      if (result.rows.length === 0) return undefined;
      return rowToRegistration(result.rows[0]);
    }
    return this._regLog.get(id);
  }

  async deleteWebhook(id: string): Promise<boolean> {
    const pool = this.pool();
    if (pool) {
      const result = await pool.query(
        'DELETE FROM webhook_registrations WHERE id = $1',
        [id]
      );
      return (result.rowCount ?? 0) > 0;
    }
    if (!this._regLog.has(id)) return false;
    this._regLog.delete(id);
    return true;
  }

  // ── Deliveries ───────────────────────────────────────────────────────────

  async createDelivery(
    webhookId: string,
    credentialId: number,
    event: string,
    payload: WebhookPayload
  ): Promise<DeliveryRecord> {
    const orderKey = orderKeyFor(webhookId, credentialId);

    const pool = this.pool();
    if (pool) {
      // Derive next sequence number via MAX within the order partition
      const seqResult = await pool.query<{ max_seq: number | null }>(
        `SELECT MAX(sequence) AS max_seq FROM webhook_deliveries WHERE order_key = $1`,
        [orderKey]
      );
      const nextSeq = (seqResult.rows[0].max_seq ?? 0) + 1;
      const id = `dlv_${Date.now()}_${randomSuffix()}`;
      const createdAt = new Date().toISOString();

      await pool.query(
        `INSERT INTO webhook_deliveries
           (id, webhook_id, credential_id, event, payload, order_key, sequence, status, attempts, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8)`,
        [id, webhookId, credentialId, event, JSON.stringify(payload), orderKey, nextSeq, createdAt]
      );

      return {
        id,
        webhookId,
        credentialId,
        event,
        payload,
        orderKey,
        sequence: nextSeq,
        status: 'pending',
        attempts: 0,
        createdAt,
      };
    }

    // DurableLog fallback
    this.deliveryCounter += 1;
    const sequence = (this.sequenceCounters.get(orderKey) ?? 0) + 1;
    this.sequenceCounters.set(orderKey, sequence);
    const record: DeliveryRecord = {
      id: `dlv_${this.deliveryCounter}`,
      webhookId,
      credentialId,
      event,
      payload,
      orderKey,
      sequence,
      status: 'pending',
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this._delLog.set(record.id, record);
    return record;
  }

  async saveDelivery(record: DeliveryRecord): Promise<void> {
    const pool = this.pool();
    if (pool) {
      await pool.query(
        `INSERT INTO webhook_deliveries
           (id, webhook_id, credential_id, event, payload, order_key, sequence,
            status, attempts, last_attempt_at, error, created_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           status          = EXCLUDED.status,
           attempts        = EXCLUDED.attempts,
           last_attempt_at = EXCLUDED.last_attempt_at,
           error           = EXCLUDED.error,
           completed_at    = EXCLUDED.completed_at`,
        [
          record.id,
          record.webhookId,
          record.credentialId,
          record.event,
          JSON.stringify(record.payload),
          record.orderKey,
          record.sequence,
          record.status,
          record.attempts,
          record.lastAttemptAt ?? null,
          record.error ?? null,
          record.createdAt,
          record.completedAt ?? null,
        ]
      );
      return;
    }
    this._delLog.set(record.id, record);
  }

  async getDelivery(id: string): Promise<DeliveryRecord | undefined> {
    const pool = this.pool();
    if (pool) {
      const result = await pool.query<{
        id: string; webhook_id: string; credential_id: number; event: string;
        payload: WebhookPayload; order_key: string; sequence: number; status: string;
        attempts: number; last_attempt_at: Date | null; error: string | null;
        created_at: Date; completed_at: Date | null;
      }>(
        `SELECT id, webhook_id, credential_id, event, payload, order_key, sequence,
                status, attempts, last_attempt_at, error, created_at, completed_at
         FROM webhook_deliveries WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) return undefined;
      return rowToDelivery(result.rows[0]);
    }
    return this._delLog.get(id);
  }

  async listDeliveries(): Promise<DeliveryRecord[]> {
    const pool = this.pool();
    if (pool) {
      const result = await pool.query<{
        id: string; webhook_id: string; credential_id: number; event: string;
        payload: WebhookPayload; order_key: string; sequence: number; status: string;
        attempts: number; last_attempt_at: Date | null; error: string | null;
        created_at: Date; completed_at: Date | null;
      }>(
        `SELECT id, webhook_id, credential_id, event, payload, order_key, sequence,
                status, attempts, last_attempt_at, error, created_at, completed_at
         FROM webhook_deliveries ORDER BY created_at ASC`
      );
      return result.rows.map(rowToDelivery);
    }
    return this._delLog.values();
  }

  /** Pending deliveries, grouped and sorted by (orderKey, sequence). */
  async listPendingByOrderKey(): Promise<Map<string, DeliveryRecord[]>> {
    const pool = this.pool();
    if (pool) {
      const result = await pool.query<{
        id: string; webhook_id: string; credential_id: number; event: string;
        payload: WebhookPayload; order_key: string; sequence: number; status: string;
        attempts: number; last_attempt_at: Date | null; error: string | null;
        created_at: Date; completed_at: Date | null;
      }>(
        `SELECT id, webhook_id, credential_id, event, payload, order_key, sequence,
                status, attempts, last_attempt_at, error, created_at, completed_at
         FROM webhook_deliveries
         WHERE status = 'pending'
         ORDER BY order_key, sequence ASC`
      );
      const byKey = new Map<string, DeliveryRecord[]>();
      for (const row of result.rows) {
        const rec = rowToDelivery(row);
        const list = byKey.get(rec.orderKey) ?? [];
        list.push(rec);
        byKey.set(rec.orderKey, list);
      }
      return byKey;
    }

    // DurableLog fallback
    const byKey = new Map<string, DeliveryRecord[]>();
    for (const rec of this._delLog.values()) {
      if (rec.status !== 'pending') continue;
      const list = byKey.get(rec.orderKey) ?? [];
      list.push(rec);
      byKey.set(rec.orderKey, list);
    }
    for (const list of byKey.values()) list.sort((a, b) => a.sequence - b.sequence);
    return byKey;
  }

  async listDeadLetters(): Promise<DeliveryRecord[]> {
    const pool = this.pool();
    if (pool) {
      const result = await pool.query<{
        id: string; webhook_id: string; credential_id: number; event: string;
        payload: WebhookPayload; order_key: string; sequence: number; status: string;
        attempts: number; last_attempt_at: Date | null; error: string | null;
        created_at: Date; completed_at: Date | null;
      }>(
        `SELECT id, webhook_id, credential_id, event, payload, order_key, sequence,
                status, attempts, last_attempt_at, error, created_at, completed_at
         FROM webhook_deliveries WHERE status = 'dead_letter' ORDER BY created_at ASC`
      );
      return result.rows.map(rowToDelivery);
    }
    return this._delLog.values().filter((rec) => rec.status === 'dead_letter');
  }

  /** Reset state — for testing only. */
  async _resetForTest(): Promise<void> {
    const pool = this.pool();
    if (pool) {
      await pool.query('DELETE FROM webhook_deliveries');
      await pool.query('DELETE FROM webhook_registrations');
    } else {
      for (const key of this._regLog.keys()) this._regLog.delete(key);
      for (const key of this._delLog.keys()) this._delLog.delete(key);
      this.regCounter = 0;
      this.deliveryCounter = 0;
      this.sequenceCounters.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let defaultStore: WebhookStore | undefined;

export function getDefaultWebhookStore(): WebhookStore {
  if (!defaultStore) defaultStore = new WebhookStore();
  return defaultStore;
}

/** Test-only: force the module to construct a fresh default store. */
export function _setDefaultWebhookStoreForTest(store: WebhookStore | undefined): void {
  defaultStore = store;
}
