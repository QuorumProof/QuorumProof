/**
 * Issue #1301: Auth Audit Logging Service
 *
 * Logs all authentication events (login, logout, MFA, key rotation) with
 * timestamp, user, IP, and status. Provides alerting for suspicious patterns
 * such as multiple failed logins.
 *
 * Storage: Postgres-backed (auth_audit_log table) when a pool is available;
 * falls back to the original in-memory implementation in test environments
 * where no pool is initialised. In-memory sliding-window failure counters
 * (ipFailureCounts / userFailureCounts) are always kept in-memory for
 * low-latency anomaly detection.
 */

import { getPool } from '../db.js';
import type { Pool as PgPool } from 'pg';

export type AuthEventType =
  | 'login_success'
  | 'login_failure'
  | 'logout'
  | 'magic_link_requested'
  | 'magic_link_verified'
  | 'magic_link_failed'
  | 'webauthn_registered'
  | 'webauthn_verified'
  | 'webauthn_failed'
  | 'mfa_success'
  | 'mfa_failure'
  | 'key_rotation'
  | 'token_refreshed'
  | 'session_expired'
  | 'account_locked';

export interface AuthAuditEntry {
  id: string;
  event_type: AuthEventType;
  user_id: string | null;
  ip_address: string;
  user_agent: string;
  status: 'success' | 'failure' | 'info';
  metadata: Record<string, unknown>;
  timestamp: string; // ISO 8601
}

export interface AuthAuditFilter {
  user_id?: string;
  event_type?: AuthEventType;
  status?: 'success' | 'failure' | 'info';
  start_date?: string; // ISO 8601
  end_date?: string; // ISO 8601
  ip_address?: string;
  limit?: number;
  offset?: number;
}

export interface SuspiciousAlert {
  type: 'brute_force' | 'credential_stuffing' | 'distributed_attack';
  user_id: string | null;
  ip_address: string;
  failure_count: number;
  window_seconds: number;
  detected_at: string;
  recent_events: AuthAuditEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ALERT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const IP_FAILURE_THRESHOLD = 10;
export const USER_FAILURE_THRESHOLD = 5;

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

// ---------------------------------------------------------------------------
// Event classification helpers
// ---------------------------------------------------------------------------

const SUCCESS_EVENTS = new Set<AuthEventType>([
  'login_success',
  'magic_link_verified',
  'webauthn_registered',
  'webauthn_verified',
  'mfa_success',
  'token_refreshed',
  'logout',
]);

const FAILURE_EVENTS = new Set<AuthEventType>([
  'login_failure',
  'magic_link_failed',
  'webauthn_failed',
  'mfa_failure',
]);

function inferStatus(event_type: AuthEventType): 'success' | 'failure' | 'info' {
  if (SUCCESS_EVENTS.has(event_type)) return 'success';
  if (FAILURE_EVENTS.has(event_type)) return 'failure';
  return 'info';
}

// ---------------------------------------------------------------------------
// In-memory fallback store
// ---------------------------------------------------------------------------

const _authAuditLog: AuthAuditEntry[] = [];
let _entryCounter = 0;

function generateId(): string {
  return `auth-${Date.now()}-${++_entryCounter}`;
}

// ---------------------------------------------------------------------------
// In-memory sliding-window failure counters (always in-memory for speed)
// ---------------------------------------------------------------------------

const ipFailureCounts = new Map<string, { count: number; windowStart: number; entries: string[] }>();
const userFailureCounts = new Map<string, { count: number; windowStart: number; entries: string[] }>();

// Cache of recent entries referenced by anomaly-detection logic when in PG mode
const _recentFailureCache = new Map<string, AuthAuditEntry>();

function trackFailure(entry: AuthAuditEntry): void {
  const now = Date.now();

  // Per-IP tracking
  const ipKey = entry.ip_address;
  const ipRecord = ipFailureCounts.get(ipKey) ?? { count: 0, windowStart: now, entries: [] };
  if (now - ipRecord.windowStart > ALERT_WINDOW_MS) {
    ipRecord.count = 0;
    ipRecord.windowStart = now;
    ipRecord.entries = [];
  }
  ipRecord.count++;
  ipRecord.entries.push(entry.id);
  ipFailureCounts.set(ipKey, ipRecord);

  // Per-user tracking
  if (entry.user_id) {
    const userRecord = userFailureCounts.get(entry.user_id) ?? { count: 0, windowStart: now, entries: [] };
    if (now - userRecord.windowStart > ALERT_WINDOW_MS) {
      userRecord.count = 0;
      userRecord.windowStart = now;
      userRecord.entries = [];
    }
    userRecord.count++;
    userRecord.entries.push(entry.id);
    userFailureCounts.set(entry.user_id, userRecord);
  }

  // Keep a small in-process cache so detectSuspiciousActivity can build recent_events
  _recentFailureCache.set(entry.id, entry);
  // Trim cache to prevent unbounded growth
  if (_recentFailureCache.size > 1000) {
    const firstKey = _recentFailureCache.keys().next().value;
    if (firstKey !== undefined) _recentFailureCache.delete(firstKey);
  }
}

// ---------------------------------------------------------------------------
// logAuthEvent
// ---------------------------------------------------------------------------

/**
 * Log an authentication event.
 * Returns a Promise<AuthAuditEntry> so callers can await if needed.
 */
export async function logAuthEvent(
  event_type: AuthEventType,
  opts: {
    user_id?: string | null;
    ip_address?: string;
    user_agent?: string;
    status?: 'success' | 'failure' | 'info';
    metadata?: Record<string, unknown>;
  } = {}
): Promise<AuthAuditEntry> {
  const entry: AuthAuditEntry = {
    id: generateId(),
    event_type,
    user_id: opts.user_id ?? null,
    ip_address: opts.ip_address ?? 'unknown',
    user_agent: opts.user_agent ?? '',
    status: opts.status ?? inferStatus(event_type),
    metadata: opts.metadata ?? {},
    timestamp: new Date().toISOString(),
  };

  const pool = resolvePool();
  if (pool) {
    await pool.query(
      `INSERT INTO auth_audit_log
         (id, event_type, user_id, ip_address, user_agent, status, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.id,
        entry.event_type,
        entry.user_id,
        entry.ip_address,
        entry.user_agent,
        entry.status,
        JSON.stringify(entry.metadata),
        entry.timestamp,
      ]
    );
  } else {
    _authAuditLog.push(entry);
  }

  // Always update in-memory failure trackers
  if (entry.status === 'failure') {
    trackFailure(entry);
  }

  return entry;
}

// ---------------------------------------------------------------------------
// detectSuspiciousActivity (always sync — uses in-memory counters)
// ---------------------------------------------------------------------------

/**
 * Check for suspicious patterns and return alerts.
 * Uses in-memory sliding-window counters populated by trackFailure().
 */
export function detectSuspiciousActivity(): SuspiciousAlert[] {
  const alerts: SuspiciousAlert[] = [];
  const now = Date.now();
  const detectedAt = new Date().toISOString();

  // Check per-IP brute force
  for (const [ip, record] of ipFailureCounts) {
    if (now - record.windowStart > ALERT_WINDOW_MS) continue;
    if (record.count >= IP_FAILURE_THRESHOLD) {
      // Reconstruct recent events from cache (PG mode) or audit log (in-memory mode)
      const recentEvents = record.entries
        .map((id) => _recentFailureCache.get(id) ?? _authAuditLog.find((e) => e.id === id))
        .filter((e): e is AuthAuditEntry => e !== undefined)
        .slice(-5);

      alerts.push({
        type: 'brute_force',
        user_id: null,
        ip_address: ip,
        failure_count: record.count,
        window_seconds: Math.ceil(ALERT_WINDOW_MS / 1000),
        detected_at: detectedAt,
        recent_events: recentEvents,
      });
    }
  }

  // Check per-user credential stuffing
  for (const [userId, record] of userFailureCounts) {
    if (now - record.windowStart > ALERT_WINDOW_MS) continue;
    if (record.count >= USER_FAILURE_THRESHOLD) {
      const recentEvents = record.entries
        .map((id) => _recentFailureCache.get(id) ?? _authAuditLog.find((e) => e.id === id))
        .filter((e): e is AuthAuditEntry => e !== undefined)
        .slice(-5);

      alerts.push({
        type: 'credential_stuffing',
        user_id: userId,
        ip_address: 'various',
        failure_count: record.count,
        window_seconds: Math.ceil(ALERT_WINDOW_MS / 1000),
        detected_at: detectedAt,
        recent_events: recentEvents,
      });
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// queryAuthEvents
// ---------------------------------------------------------------------------

/**
 * Query auth audit events with filtering.
 */
export async function queryAuthEvents(filter: AuthAuditFilter = {}): Promise<{
  data: AuthAuditEntry[];
  total: number;
  offset: number;
  limit: number;
}> {
  const offset = filter.offset ?? 0;
  const limit = Math.min(filter.limit ?? 50, 200);

  const pool = resolvePool();
  if (pool) {
    // Build dynamic WHERE clause
    const conditions: string[] = [];
    const params: unknown[] = [];

    function addParam(value: unknown): string {
      params.push(value);
      return `$${params.length}`;
    }

    if (filter.user_id !== undefined) conditions.push(`user_id = ${addParam(filter.user_id)}`);
    if (filter.event_type !== undefined) conditions.push(`event_type = ${addParam(filter.event_type)}`);
    if (filter.status !== undefined) conditions.push(`status = ${addParam(filter.status)}`);
    if (filter.ip_address !== undefined) conditions.push(`ip_address = ${addParam(filter.ip_address)}`);
    if (filter.start_date !== undefined) conditions.push(`created_at >= ${addParam(filter.start_date)}`);
    if (filter.end_date !== undefined) conditions.push(`created_at <= ${addParam(filter.end_date)}`);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM auth_audit_log ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Fetch page
    const dataResult = await pool.query<{
      id: string;
      event_type: string;
      user_id: string | null;
      ip_address: string;
      user_agent: string;
      status: string;
      metadata: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, event_type, user_id, ip_address, user_agent, status, metadata, created_at
       FROM auth_audit_log
       ${where}
       ORDER BY created_at DESC
       LIMIT ${addParam(limit)} OFFSET ${addParam(offset)}`,
      params
    );

    const data: AuthAuditEntry[] = dataResult.rows.map((row) => ({
      id: row.id,
      event_type: row.event_type as AuthEventType,
      user_id: row.user_id,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      status: row.status as 'success' | 'failure' | 'info',
      metadata: row.metadata,
      timestamp: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));

    return { data, total, offset, limit };
  }

  // In-memory fallback
  let results = [..._authAuditLog];

  if (filter.user_id) results = results.filter((e) => e.user_id === filter.user_id);
  if (filter.event_type) results = results.filter((e) => e.event_type === filter.event_type);
  if (filter.status) results = results.filter((e) => e.status === filter.status);
  if (filter.ip_address) results = results.filter((e) => e.ip_address === filter.ip_address);
  if (filter.start_date) {
    const start = new Date(filter.start_date).getTime();
    results = results.filter((e) => new Date(e.timestamp).getTime() >= start);
  }
  if (filter.end_date) {
    const end = new Date(filter.end_date).getTime();
    results = results.filter((e) => new Date(e.timestamp).getTime() <= end);
  }

  results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const total = results.length;
  return {
    data: results.slice(offset, offset + limit),
    total,
    offset,
    limit,
  };
}

// ---------------------------------------------------------------------------
// clearAuthAuditLog (test isolation)
// ---------------------------------------------------------------------------

/**
 * Clear the audit log (for testing purposes).
 */
export async function clearAuthAuditLog(): Promise<void> {
  ipFailureCounts.clear();
  userFailureCounts.clear();
  _recentFailureCache.clear();
  _entryCounter = 0;

  const pool = resolvePool();
  if (pool) {
    await pool.query('DELETE FROM auth_audit_log');
  } else {
    _authAuditLog.length = 0;
  }
}
