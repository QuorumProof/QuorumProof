/**
 * Tests for Issue #1301: Auth Audit Logging
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  logAuthEvent,
  queryAuthEvents,
  detectSuspiciousActivity,
  clearAuthAuditLog,
  IP_FAILURE_THRESHOLD,
} from '../src/services/authAudit.js';
import authAuditRouter from '../src/routes/authAudit.js';

// ─── Service Unit Tests ────────────────────────────────────────────────────────

describe('Auth Audit Service', () => {
  beforeEach(() => {
    clearAuthAuditLog();
  });

  it('logs a login_success event', () => {
    const entry = logAuthEvent('login_success', {
      user_id: 'alice@example.com',
      ip_address: '1.2.3.4',
      status: 'success',
    });

    expect(entry.event_type).toBe('login_success');
    expect(entry.user_id).toBe('alice@example.com');
    expect(entry.ip_address).toBe('1.2.3.4');
    expect(entry.status).toBe('success');
    expect(entry.timestamp).toMatch(/^\d{4}-/); // ISO format
    expect(entry.id).toMatch(/^auth-/);
  });

  it('logs a login_failure event', () => {
    const entry = logAuthEvent('login_failure', {
      user_id: 'bob@example.com',
      ip_address: '5.6.7.8',
    });

    expect(entry.status).toBe('failure');
  });

  it('infers status from event type suffix', () => {
    const successEntry = logAuthEvent('magic_link_verified', { user_id: 'u1' });
    expect(successEntry.status).toBe('success');

    const failureEntry = logAuthEvent('mfa_failure', { user_id: 'u1' });
    expect(failureEntry.status).toBe('failure');
  });

  it('defaults to info status for neutral events', () => {
    const entry = logAuthEvent('key_rotation', { user_id: 'u1' });
    expect(entry.status).toBe('info');
  });

  it('queryAuthEvents returns all events', () => {
    logAuthEvent('login_success', { user_id: 'u1', ip_address: '1.1.1.1' });
    logAuthEvent('login_failure', { user_id: 'u2', ip_address: '2.2.2.2' });

    const result = queryAuthEvents();
    expect(result.total).toBe(2);
    expect(result.data).toHaveLength(2);
  });

  it('queryAuthEvents filters by user_id', () => {
    logAuthEvent('login_success', { user_id: 'alice' });
    logAuthEvent('login_success', { user_id: 'bob' });

    const result = queryAuthEvents({ user_id: 'alice' });
    expect(result.total).toBe(1);
    expect(result.data[0].user_id).toBe('alice');
  });

  it('queryAuthEvents filters by event_type', () => {
    logAuthEvent('login_success', { user_id: 'alice' });
    logAuthEvent('logout', { user_id: 'alice' });

    const result = queryAuthEvents({ event_type: 'logout' });
    expect(result.total).toBe(1);
    expect(result.data[0].event_type).toBe('logout');
  });

  it('queryAuthEvents filters by status', () => {
    logAuthEvent('login_success', { user_id: 'alice' });
    logAuthEvent('login_failure', { user_id: 'alice' });

    const failuresOnly = queryAuthEvents({ status: 'failure' });
    expect(failuresOnly.total).toBe(1);
    expect(failuresOnly.data[0].status).toBe('failure');
  });

  it('queryAuthEvents paginates with offset and limit', () => {
    for (let i = 0; i < 10; i++) {
      logAuthEvent('login_success', { user_id: `user${i}` });
    }

    const page1 = queryAuthEvents({ limit: 4, offset: 0 });
    expect(page1.data).toHaveLength(4);
    expect(page1.limit).toBe(4);
    expect(page1.offset).toBe(0);

    const page2 = queryAuthEvents({ limit: 4, offset: 4 });
    expect(page2.data).toHaveLength(4);
    expect(page2.offset).toBe(4);
  });

  it('queryAuthEvents filters by ip_address', () => {
    logAuthEvent('login_failure', { ip_address: '10.0.0.1' });
    logAuthEvent('login_failure', { ip_address: '10.0.0.2' });

    const result = queryAuthEvents({ ip_address: '10.0.0.1' });
    expect(result.total).toBe(1);
    expect(result.data[0].ip_address).toBe('10.0.0.1');
  });

  it('detectSuspiciousActivity returns brute force alert after threshold failures from same IP', () => {
    for (let i = 0; i < IP_FAILURE_THRESHOLD; i++) {
      logAuthEvent('login_failure', { ip_address: '192.168.1.1' });
    }

    const alerts = detectSuspiciousActivity();
    expect(alerts.length).toBeGreaterThan(0);
    const bruteForce = alerts.find((a) => a.type === 'brute_force');
    expect(bruteForce).toBeDefined();
    expect(bruteForce?.ip_address).toBe('192.168.1.1');
    expect(bruteForce?.failure_count).toBeGreaterThanOrEqual(IP_FAILURE_THRESHOLD);
  });

  it('detectSuspiciousActivity returns no alerts below threshold', () => {
    for (let i = 0; i < IP_FAILURE_THRESHOLD - 1; i++) {
      logAuthEvent('login_failure', { ip_address: '10.1.2.3' });
    }

    const alerts = detectSuspiciousActivity();
    const bruteForce = alerts.filter((a) => a.ip_address === '10.1.2.3');
    expect(bruteForce).toHaveLength(0);
  });
});

// ─── Route Integration Tests ───────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  // Simulate admin role header (bypass real RBAC for route tests).
  app.use((req, _res, next) => {
    req.headers['x-role'] = 'admin';
    next();
  });
  app.use('/api/audit/auth-events', authAuditRouter);
  return app;
}

describe('GET /api/audit/auth-events', () => {
  beforeEach(() => clearAuthAuditLog());

  it('returns empty list when no events logged', async () => {
    const res = await request(makeApp()).get('/api/audit/auth-events');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.data).toHaveLength(0);
  });

  it('returns all logged events', async () => {
    logAuthEvent('login_success', { user_id: 'alice', ip_address: '1.1.1.1' });
    logAuthEvent('login_failure', { user_id: 'bob', ip_address: '2.2.2.2' });

    const res = await request(makeApp()).get('/api/audit/auth-events');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('filters by user_id query param', async () => {
    logAuthEvent('login_success', { user_id: 'alice' });
    logAuthEvent('login_success', { user_id: 'bob' });

    const res = await request(makeApp()).get('/api/audit/auth-events?user_id=alice');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].user_id).toBe('alice');
  });

  it('filters by event_type query param', async () => {
    logAuthEvent('login_success', { user_id: 'u1' });
    logAuthEvent('logout', { user_id: 'u1' });

    const res = await request(makeApp()).get('/api/audit/auth-events?event_type=logout');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('returns 400 for invalid event_type', async () => {
    const res = await request(makeApp()).get('/api/audit/auth-events?event_type=invalid_type');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid event_type');
  });

  it('returns 400 for invalid status', async () => {
    const res = await request(makeApp()).get('/api/audit/auth-events?status=unknown');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid status');
  });

  it('returns 400 for invalid start_date', async () => {
    const res = await request(makeApp()).get('/api/audit/auth-events?start_date=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid start_date');
  });

  it('returns 400 when start_date is after end_date', async () => {
    const res = await request(makeApp()).get('/api/audit/auth-events?start_date=2025-01-01&end_date=2024-01-01');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('start_date must be before end_date');
  });

  it('returns 401 without admin role', async () => {
    const appNoAdmin = express();
    appNoAdmin.use(express.json());
    appNoAdmin.use('/api/audit/auth-events', authAuditRouter);
    const res = await request(appNoAdmin).get('/api/audit/auth-events');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/audit/auth-events/alerts', () => {
  beforeEach(() => clearAuthAuditLog());

  it('returns alert count and alerts array', async () => {
    const res = await request(makeApp()).get('/api/audit/auth-events/alerts');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('count');
    expect(Array.isArray(res.body.alerts)).toBe(true);
  });

  it('detects brute force alert via route', async () => {
    for (let i = 0; i < IP_FAILURE_THRESHOLD; i++) {
      logAuthEvent('login_failure', { ip_address: '99.99.99.99' });
    }

    const res = await request(makeApp()).get('/api/audit/auth-events/alerts');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThan(0);
    expect(res.body.alerts[0].type).toBe('brute_force');
  });
});
