/**
 * Credential Notification System (#550)
 *
 * Provides email/SMS notification dispatch, configurable preferences per address,
 * a notification history store, and batching of events from the same issuer
 * within a configurable time window.
 *
 * Storage: Postgres-backed (notification_preferences + notification_history
 * tables) when a pool is available; falls back to the original in-memory
 * implementation in test environments where no pool is initialised.
 */

import { getPool } from '../db.js';
import type { Pool as PgPool } from 'pg';

export type NotificationChannel = 'email' | 'sms';

export type NotificationEvent =
  | 'credential_issued'
  | 'credential_revoked'
  | 'credential_suspended'
  | 'credential_attested'
  | 'credential_expiring';

export interface NotificationPreferences {
  address: string;
  email?: string;
  phone?: string;
  channels: NotificationChannel[];
  events: NotificationEvent[];
  /** Optional allowlist of credential types (e.g. 1=Degree, 2=License, 3=Employment).
   *  When set, notifications are only dispatched for credentials whose type is in this list.
   *  When absent or empty, all credential types are notified. */
  credential_type_filters?: number[];
  enabled: boolean;
}

export interface NotificationRecord {
  id: string;
  address: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  credential_id: number;
  /** When batched, contains all credential IDs in the batch (undefined for single notifications). */
  batched_credential_ids?: number[];
  issuer?: string;
  message: string;
  sent_at: string;
  success: boolean;
  error?: string;
}

interface BatchEntry {
  events: Array<{ event: NotificationEvent; credentialId: number }>;
  timer: ReturnType<typeof setTimeout>;
}

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

// ---------------------------------------------------------------------------
// In-memory fallback stores (used when no Postgres pool is available)
// ---------------------------------------------------------------------------
const _preferencesStore = new Map<string, NotificationPreferences>();
const _historyStore: NotificationRecord[] = [];
let _notificationCounter = 0;

// Injected pool for tests (takes priority over global getPool())
let _testPool: PgPool | null = null;

/** Test helper — inject a mock pool so tests can control DB behaviour. */
export function _setPoolForTest(pool: PgPool | null): void {
  _testPool = pool;
}

/** Resolve the active pool: test-injected > global singleton > null (fallback). */
function resolvePool(): PgPool | null {
  if (_testPool !== null) return _testPool;
  return getPoolSafe();
}

/** Batch key: "<address>:<issuer>" */
const batchStore = new Map<string, BatchEntry>();

/** Time window (ms) during which events from the same issuer are grouped. */
export const BATCH_WINDOW_MS = 5_000;

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/** Build a human-readable message for a single credential event. */
function buildMessage(event: NotificationEvent, credentialId: number): string {
  switch (event) {
    case 'credential_issued':
      return `Your credential #${credentialId} has been issued.`;
    case 'credential_revoked':
      return `Your credential #${credentialId} has been revoked.`;
    case 'credential_suspended':
      return `Your credential #${credentialId} has been suspended.`;
    case 'credential_attested':
      return `Your credential #${credentialId} received a new attestation.`;
    case 'credential_expiring':
      return `Your credential #${credentialId} is expiring soon. Please renew.`;
  }
}

/** Build a human-readable message summarising a batch of credential events. */
function buildBatchMessage(
  events: Array<{ event: NotificationEvent; credentialId: number }>,
  issuer?: string
): string {
  const ids = events.map((e) => `#${e.credentialId}`).join(', ');
  const prefix = issuer ? `From ${issuer}: ` : '';
  return `${prefix}${events.length} credential updates for credentials ${ids}.`;
}

// ---------------------------------------------------------------------------
// Mock send functions
// ---------------------------------------------------------------------------

/**
 * Simulate sending an email notification.
 * Replace with a real provider (e.g. SendGrid, SES) in production.
 */
async function sendEmail(to: string, message: string): Promise<void> {
  console.log(`[EMAIL] To: ${to} | ${message}`);
}

/**
 * Simulate sending an SMS notification.
 * Replace with a real provider (e.g. Twilio) in production.
 */
async function sendSms(phone: string, message: string): Promise<void> {
  console.log(`[SMS] To: ${phone} | ${message}`);
}

// ---------------------------------------------------------------------------
// Dispatch + batching
// ---------------------------------------------------------------------------

/**
 * Dispatch a notification for a credential event.  Events from the same issuer
 * arriving within BATCH_WINDOW_MS are grouped into a single notification.
 *
 * @param address      Stellar address of the credential holder.
 * @param event        The credential lifecycle event.
 * @param credentialId The credential being affected.
 * @param issuer       Optional issuer identity used as the batch grouping key.
 * @param credentialType Optional credential type number; used to filter against
 *   per-preference `credential_type_filters` (issue #928).
 */
export async function dispatchNotification(
  address: string,
  event: NotificationEvent,
  credentialId: number,
  issuer?: string,
  credentialType?: number
): Promise<void> {
  const prefs = await getPreferences(address);
  if (!prefs || !prefs.enabled || !prefs.events.includes(event)) return;

  // #928: skip if user has type filters and this credential type isn't in them
  if (
    credentialType !== undefined &&
    prefs.credential_type_filters &&
    prefs.credential_type_filters.length > 0 &&
    !prefs.credential_type_filters.includes(credentialType)
  ) return;

  const batchKey = `${address}:${issuer ?? ''}`;
  const existing = batchStore.get(batchKey);

  if (existing) {
    // Extend the batch with the new event and reset the window timer
    existing.events.push({ event, credentialId });
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushBatch(address, issuer, batchKey), BATCH_WINDOW_MS);
  } else {
    // Start a new batch window
    const timer = setTimeout(() => flushBatch(address, issuer, batchKey), BATCH_WINDOW_MS);
    batchStore.set(batchKey, { events: [{ event, credentialId }], timer });
  }
}

/**
 * Immediately flush any pending batch for the given address/issuer pair.
 * Useful in tests or when an explicit "send now" is needed.
 */
export async function flushPendingBatch(address: string, issuer?: string): Promise<void> {
  const batchKey = `${address}:${issuer ?? ''}`;
  await flushBatch(address, issuer, batchKey);
}

/**
 * Internal function to flush a batch and send the notification.
 */
async function flushBatch(address: string, issuer: string | undefined, batchKey: string): Promise<void> {
  const entry = batchStore.get(batchKey);
  if (!entry || entry.events.length === 0) return;

  const prefs = await getPreferences(address);
  if (!prefs || !prefs.enabled) {
    batchStore.delete(batchKey);
    return;
  }

  const message = buildBatchMessage(entry.events, issuer);
  const pool = resolvePool();

  for (const channel of prefs.channels) {
    const sentAt = new Date().toISOString();
    let success = false;
    let error: string | undefined;

    try {
      if (channel === 'email' && prefs.email) {
        await sendEmail(prefs.email, message);
        success = true;
      } else if (channel === 'sms' && prefs.phone) {
        await sendSms(prefs.phone, message);
        success = true;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (pool) {
      // Postgres path — insert and discard the returned row (id comes from BIGSERIAL)
      await pool.query(
        `INSERT INTO notification_history
           (address, event, channel, credential_id, batched_credential_ids, issuer, message, sent_at, success, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          address,
          entry.events[0].event,
          channel,
          entry.events[0].credentialId,
          entry.events.length > 1 ? entry.events.map((e) => e.credentialId) : null,
          issuer ?? null,
          message,
          sentAt,
          success,
          error ?? null,
        ]
      );
    } else {
      // In-memory fallback
      const record: NotificationRecord = {
        id: String(++_notificationCounter),
        address,
        event: entry.events[0].event,
        channel,
        credential_id: entry.events[0].credentialId,
        batched_credential_ids: entry.events.length > 1 ? entry.events.map((e) => e.credentialId) : undefined,
        issuer,
        message,
        sent_at: sentAt,
        success,
        error,
      };
      _historyStore.push(record);
    }
  }

  batchStore.delete(batchKey);
}

// ---------------------------------------------------------------------------
// Preferences CRUD
// ---------------------------------------------------------------------------

/** Upsert notification preferences for an address. */
export async function setPreferences(prefs: NotificationPreferences): Promise<void> {
  const normalised: NotificationPreferences = {
    ...prefs,
    credential_type_filters: prefs.credential_type_filters ?? [],
  };

  const pool = resolvePool();
  if (pool) {
    await pool.query(
      `INSERT INTO notification_preferences
         (address, email, phone, channels, events, credential_type_filters, enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (address) DO UPDATE SET
         email                  = EXCLUDED.email,
         phone                  = EXCLUDED.phone,
         channels               = EXCLUDED.channels,
         events                 = EXCLUDED.events,
         credential_type_filters = EXCLUDED.credential_type_filters,
         enabled                = EXCLUDED.enabled,
         updated_at             = now()`,
      [
        normalised.address,
        normalised.email ?? null,
        normalised.phone ?? null,
        normalised.channels,
        normalised.events,
        normalised.credential_type_filters ?? [],
        normalised.enabled,
      ]
    );
  } else {
    _preferencesStore.set(normalised.address, normalised);
  }
}

/** Retrieve notification preferences for an address. */
export async function getPreferences(address: string): Promise<NotificationPreferences | undefined> {
  const pool = resolvePool();
  if (pool) {
    const result = await pool.query<{
      address: string;
      email: string | null;
      phone: string | null;
      channels: string[];
      events: string[];
      credential_type_filters: number[];
      enabled: boolean;
    }>(
      `SELECT address, email, phone, channels, events, credential_type_filters, enabled
       FROM notification_preferences
       WHERE address = $1`,
      [address]
    );
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0];
    return {
      address: row.address,
      email: row.email ?? undefined,
      phone: row.phone ?? undefined,
      channels: row.channels as NotificationChannel[],
      events: row.events as NotificationEvent[],
      credential_type_filters: row.credential_type_filters,
      enabled: row.enabled,
    };
  }
  return _preferencesStore.get(address);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Retrieve notification history, optionally filtered by address. */
export async function getHistory(address?: string): Promise<NotificationRecord[]> {
  const pool = resolvePool();
  if (pool) {
    const result = await pool.query<{
      id: string;
      address: string;
      event: string;
      channel: string;
      credential_id: number;
      batched_credential_ids: number[] | null;
      issuer: string | null;
      message: string;
      sent_at: Date;
      success: boolean;
      error: string | null;
    }>(
      address
        ? `SELECT id::text, address, event, channel, credential_id, batched_credential_ids,
                  issuer, message, sent_at, success, error
           FROM notification_history
           WHERE address = $1
           ORDER BY sent_at ASC`
        : `SELECT id::text, address, event, channel, credential_id, batched_credential_ids,
                  issuer, message, sent_at, success, error
           FROM notification_history
           ORDER BY sent_at ASC`,
      address ? [address] : []
    );
    return result.rows.map((row) => ({
      id: row.id,
      address: row.address,
      event: row.event as NotificationEvent,
      channel: row.channel as NotificationChannel,
      credential_id: row.credential_id,
      batched_credential_ids: row.batched_credential_ids ?? undefined,
      issuer: row.issuer ?? undefined,
      message: row.message,
      sent_at: row.sent_at instanceof Date ? row.sent_at.toISOString() : row.sent_at,
      success: row.success,
      error: row.error ?? undefined,
    }));
  }

  // In-memory fallback
  if (address) return _historyStore.filter((r) => r.address === address);
  return [..._historyStore];
}

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

/** Clear all state (useful for test isolation). */
export async function _resetStores(): Promise<void> {
  // Always clear ephemeral batch timers
  for (const entry of batchStore.values()) clearTimeout(entry.timer);
  batchStore.clear();

  const pool = resolvePool();
  if (pool) {
    await pool.query('DELETE FROM notification_history');
    await pool.query('DELETE FROM notification_preferences');
  } else {
    _preferencesStore.clear();
    _historyStore.length = 0;
    _notificationCounter = 0;
  }
}
