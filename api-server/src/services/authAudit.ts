/**
 * Issue #1301: Auth Audit Logging Service
 *
 * Logs all authentication events (login, logout, MFA, key rotation) with
 * timestamp, user, IP, and status. Provides alerting for suspicious patterns
 * such as multiple failed logins.
 */

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

// In-memory store for this implementation.
// In production, this would be persisted to a database.
const authAuditLog: AuthAuditEntry[] = [];

// Tracks failure counts per IP and per user for anomaly detection.
const ipFailureCounts = new Map<string, { count: number; windowStart: number; entries: string[] }>();
const userFailureCounts = new Map<string, { count: number; windowStart: number; entries: string[] }>();

const ALERT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const IP_FAILURE_THRESHOLD = 10;
const USER_FAILURE_THRESHOLD = 5;

let entryCounter = 0;

function generateId(): string {
  return `auth-${Date.now()}-${++entryCounter}`;
}

/**
 * Log an authentication event.
 */
export function logAuthEvent(
  event_type: AuthEventType,
  opts: {
    user_id?: string | null;
    ip_address?: string;
    user_agent?: string;
    status?: 'success' | 'failure' | 'info';
    metadata?: Record<string, unknown>;
  } = {}
): AuthAuditEntry {
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

  authAuditLog.push(entry);

  // Track failures for anomaly detection.
  if (entry.status === 'failure') {
    trackFailure(entry);
  }

  return entry;
}

/**
 * Track failures and update suspicious activity counters.
 */
function trackFailure(entry: AuthAuditEntry): void {
  const now = Date.now();

  // Per-IP tracking.
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

  // Per-user tracking.
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
}

/**
 * Check for suspicious patterns and return alerts.
 */
export function detectSuspiciousActivity(): SuspiciousAlert[] {
  const alerts: SuspiciousAlert[] = [];
  const now = Date.now();
  const detectedAt = new Date().toISOString();

  // Check per-IP brute force.
  for (const [ip, record] of ipFailureCounts) {
    if (now - record.windowStart > ALERT_WINDOW_MS) continue;
    if (record.count >= IP_FAILURE_THRESHOLD) {
      const recentEntries = authAuditLog.filter((e) => record.entries.includes(e.id));
      alerts.push({
        type: 'brute_force',
        user_id: null,
        ip_address: ip,
        failure_count: record.count,
        window_seconds: Math.ceil(ALERT_WINDOW_MS / 1000),
        detected_at: detectedAt,
        recent_events: recentEntries.slice(-5),
      });
    }
  }

  // Check per-user credential stuffing.
  for (const [userId, record] of userFailureCounts) {
    if (now - record.windowStart > ALERT_WINDOW_MS) continue;
    if (record.count >= USER_FAILURE_THRESHOLD) {
      const recentEntries = authAuditLog.filter((e) => record.entries.includes(e.id));
      alerts.push({
        type: 'credential_stuffing',
        user_id: userId,
        ip_address: 'various',
        failure_count: record.count,
        window_seconds: Math.ceil(ALERT_WINDOW_MS / 1000),
        detected_at: detectedAt,
        recent_events: recentEntries.slice(-5),
      });
    }
  }

  return alerts;
}

/**
 * Query auth audit events with filtering.
 */
export function queryAuthEvents(filter: AuthAuditFilter = {}): {
  data: AuthAuditEntry[];
  total: number;
  offset: number;
  limit: number;
} {
  let results = [...authAuditLog];

  if (filter.user_id) {
    results = results.filter((e) => e.user_id === filter.user_id);
  }
  if (filter.event_type) {
    results = results.filter((e) => e.event_type === filter.event_type);
  }
  if (filter.status) {
    results = results.filter((e) => e.status === filter.status);
  }
  if (filter.ip_address) {
    results = results.filter((e) => e.ip_address === filter.ip_address);
  }
  if (filter.start_date) {
    const start = new Date(filter.start_date).getTime();
    results = results.filter((e) => new Date(e.timestamp).getTime() >= start);
  }
  if (filter.end_date) {
    const end = new Date(filter.end_date).getTime();
    results = results.filter((e) => new Date(e.timestamp).getTime() <= end);
  }

  // Newest first.
  results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const total = results.length;
  const offset = filter.offset ?? 0;
  const limit = Math.min(filter.limit ?? 50, 200);

  return {
    data: results.slice(offset, offset + limit),
    total,
    offset,
    limit,
  };
}

/**
 * Clear the in-memory log (for testing purposes).
 */
export function clearAuthAuditLog(): void {
  authAuditLog.length = 0;
  ipFailureCounts.clear();
  userFailureCounts.clear();
  entryCounter = 0;
}

export { ALERT_WINDOW_MS, IP_FAILURE_THRESHOLD, USER_FAILURE_THRESHOLD };
