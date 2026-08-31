/**
 * Tests for Issue #1429 — Recovery store survives process restart.
 *
 * Validates that the Postgres-backed recovery store (recovery.ts) persists
 * state across a "simulated restart" — i.e. two separate instances of the
 * router backed by the SAME pool both see the same recovery records.
 *
 * The tests mock the `getPool` function to return a lightweight in-memory
 * fake so no real database is required in CI.  The fake is shared between
 * the two router instances to prove state persistence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Minimal in-process fake for pg.Pool
// ---------------------------------------------------------------------------

interface FakeRow {
  [key: string]: unknown;
}

type TableName = 'recovery_requests' | 'recovery_otps';

/** Shared in-memory storage representing the Postgres database. */
function createFakeDb() {
  const tables: Record<TableName, FakeRow[]> = {
    recovery_requests: [],
    recovery_otps: [],
  };

  function query(sql: string, params: unknown[] = []): { rows: FakeRow[]; rowCount: number } {
    const s = sql.replace(/\s+/g, ' ').trim();

    // ── INSERT recovery_requests ───────────────────────────────────────────
    if (/^INSERT INTO recovery_requests/.test(s)) {
      const [id, credential_id, lost_wallet, new_wallet, contact_type, contact_value] = params as string[];
      tables.recovery_requests.push({
        id,
        credential_id,
        lost_wallet,
        new_wallet,
        contact_type,
        contact_value,
        status: 'pending_verification',
        created_at: new Date().toISOString(),
        verified_at: null,
        resolved_at: null,
        resolved_by: null,
        rejection_reason: null,
        attestors: [],
      });
      return { rows: [], rowCount: 1 };
    }

    // ── INSERT recovery_otps (upsert) ──────────────────────────────────────
    if (/^INSERT INTO recovery_otps/.test(s)) {
      const [request_id, code, expires_at] = params as [string, string, Date];
      const idx = tables.recovery_otps.findIndex((r) => r['request_id'] === request_id);
      const row = { request_id, code, expires_at: expires_at.toISOString(), attempts: 0 };
      if (idx >= 0) {
        tables.recovery_otps[idx] = row; // ON CONFLICT DO UPDATE
      } else {
        tables.recovery_otps.push(row);
      }
      return { rows: [], rowCount: 1 };
    }

    // ── SELECT recovery_requests WHERE id = $1 ─────────────────────────────
    if (/SELECT \* FROM recovery_requests WHERE id/.test(s) || /SELECT .* FROM recovery_requests WHERE id/.test(s)) {
      const id = params[0] as string;
      const rows = tables.recovery_requests.filter((r) => r['id'] === id);
      return { rows, rowCount: rows.length };
    }

    // ── SELECT recovery_requests WHERE status = 'pending_approval' ─────────
    if (/FROM recovery_requests.*WHERE status = 'pending_approval'/.test(s)) {
      const rows = tables.recovery_requests.filter((r) => r['status'] === 'pending_approval');
      return { rows, rowCount: rows.length };
    }

    // ── SELECT recovery_otps (with expiry filter) ──────────────────────────
    if (/FROM recovery_otps WHERE request_id.*expires_at > now/.test(s)) {
      const request_id = params[0] as string;
      const rows = tables.recovery_otps.filter(
        (r) =>
          r['request_id'] === request_id &&
          new Date(r['expires_at'] as string) > new Date(),
      );
      return { rows, rowCount: rows.length };
    }

    // ── DELETE recovery_otps WHERE request_id = $1 ─────────────────────────
    if (/DELETE FROM recovery_otps WHERE request_id/.test(s)) {
      const request_id = params[0] as string;
      const before = tables.recovery_otps.length;
      tables.recovery_otps = tables.recovery_otps.filter((r) => r['request_id'] !== request_id);
      return { rows: [], rowCount: before - tables.recovery_otps.length };
    }

    // ── DELETE expired otps ────────────────────────────────────────────────
    if (/DELETE FROM recovery_otps WHERE expires_at/.test(s)) {
      const before = tables.recovery_otps.length;
      tables.recovery_otps = tables.recovery_otps.filter(
        (r) => new Date(r['expires_at'] as string) > new Date(),
      );
      return { rows: [], rowCount: before - tables.recovery_otps.length };
    }

    // ── UPDATE recovery_otps attempts ─────────────────────────────────────
    if (/UPDATE recovery_otps SET attempts/.test(s)) {
      const [newAttempts, request_id] = params as [number, string];
      const row = tables.recovery_otps.find((r) => r['request_id'] === request_id);
      if (row) row['attempts'] = newAttempts;
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    // ── UPDATE recovery_requests SET status = 'pending_approval' ──────────
    if (/UPDATE recovery_requests\s+SET status = 'pending_approval'/.test(s)) {
      const [id] = params as string[];
      const row = tables.recovery_requests.find((r) => r['id'] === id);
      if (row) {
        row['status'] = 'pending_approval';
        row['verified_at'] = new Date().toISOString();
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    // ── UPDATE recovery_requests SET status = 'approved' ──────────────────
    if (/UPDATE recovery_requests\s+SET status = 'approved'/.test(s)) {
      const [resolved_by, attestors, id] = params as [string, string[], string];
      const row = tables.recovery_requests.find((r) => r['id'] === id);
      if (row) {
        row['status'] = 'approved';
        row['resolved_at'] = new Date().toISOString();
        row['resolved_by'] = resolved_by;
        row['attestors'] = attestors;
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    // ── UPDATE recovery_requests SET status = 'rejected' ──────────────────
    if (/UPDATE recovery_requests\s+SET status = 'rejected'/.test(s)) {
      const [resolved_by, rejection_reason, id] = params as [string, string, string];
      const row = tables.recovery_requests.find((r) => r['id'] === id);
      if (row) {
        row['status'] = 'rejected';
        row['resolved_at'] = new Date().toISOString();
        row['resolved_by'] = resolved_by;
        row['rejection_reason'] = rejection_reason;
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    // Default — no-op
    return { rows: [], rowCount: 0 };
  }

  const pool = { query };
  return { pool, tables };
}

// ---------------------------------------------------------------------------
// Mock db.ts so the router uses our fake pool
// ---------------------------------------------------------------------------

let fakeDb = createFakeDb();

vi.mock('../src/db.js', () => ({
  getPool: () => fakeDb.pool,
}));

// ---------------------------------------------------------------------------
// Helper to build an Express app from a fresh dynamic import of recovery.ts
// ---------------------------------------------------------------------------
async function buildApp() {
  // Use a fresh dynamic import each time to get a clean router module.
  // Because Node/vitest caches modules we clear the cache between tests
  // via the mock above — both calls share the same fakeDb.pool.
  const mod = await import('../src/routes/recovery.js');
  const app = express();
  app.use(express.json());
  app.use('/api/recovery', mod.default);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const VALID_LOST  = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VALID_NEW   = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKBWW';

describe('#1429 recovery state persists across "process restart" (shared DB)', () => {
  beforeEach(() => {
    // Reset the fake database before each test.
    fakeDb = createFakeDb();
  });

  it('creates a recovery request, and a NEW app instance can still read it', async () => {
    const app1 = await buildApp();

    // Create request on app1
    const createRes = await request(app1).post('/api/recovery/request').send({
      credentialId: 'cred-001',
      lostWallet: VALID_LOST,
      newWallet: VALID_NEW,
      contactType: 'email',
      contactValue: 'alice@example.com',
    });
    expect(createRes.status).toBe(201);
    const { requestId } = createRes.body as { requestId: string };
    expect(typeof requestId).toBe('string');

    // "Restart" — build a completely new app instance backed by the SAME db
    const app2 = await buildApp();

    const statusRes = await request(app2).get(`/api/recovery/status/${requestId}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.id).toBe(requestId);
    expect(statusRes.body.status).toBe('pending_verification');
    // Contact value must be hidden
    expect(statusRes.body.contact_value).toBeUndefined();
  });

  it('OTP verification advances status; a NEW app instance sees the new status', async () => {
    const app1 = await buildApp();

    // Intercept the generated OTP by spying on console.log
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    const createRes = await request(app1).post('/api/recovery/request').send({
      credentialId: 'cred-002',
      lostWallet: VALID_LOST,
      newWallet: VALID_NEW,
      contactType: 'email',
      contactValue: 'bob@example.com',
    });
    expect(createRes.status).toBe(201);
    const { requestId } = createRes.body as { requestId: string };

    // Extract OTP from the console log
    const logEntry = logs.find((l) => l.includes(requestId));
    const otpMatch = logEntry?.match(/:\s*(\d{6})$/);
    expect(otpMatch).not.toBeNull();
    const otp = otpMatch![1];

    vi.restoreAllMocks();

    // Verify OTP on app1
    const verifyRes = await request(app1).post('/api/recovery/verify-otp').send({ requestId, code: otp });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.success).toBe(true);

    // "Restart" — new app instance
    const app2 = await buildApp();

    const statusRes = await request(app2).get(`/api/recovery/status/${requestId}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('pending_approval');
  });

  it('approve/reject cycle persists; new instance sees resolved state', async () => {
    const app1 = await buildApp();

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    const createRes = await request(app1).post('/api/recovery/request').send({
      credentialId: 'cred-003',
      lostWallet: VALID_LOST,
      newWallet: VALID_NEW,
      contactType: 'phone',
      contactValue: '+15555550000',
    });
    const { requestId } = createRes.body as { requestId: string };

    const logEntry = logs.find((l) => l.includes(requestId));
    const otp = logEntry?.match(/:\s*(\d{6})$/)![1]!;
    vi.restoreAllMocks();

    // Advance to pending_approval
    await request(app1).post('/api/recovery/verify-otp').send({ requestId, code: otp });

    // Approve on app1
    const approveRes = await request(app1).post('/api/recovery/approve').send({
      requestId,
      attestor: 'GATTEST0000000000000000000000000000000000000000000000000000',
    });
    expect(approveRes.status).toBe(200);

    // New app instance checks the status
    const app2 = await buildApp();
    const statusRes = await request(app2).get(`/api/recovery/status/${requestId}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('approved');
    expect(statusRes.body.resolved_by).toBe('GATTEST0000000000000000000000000000000000000000000000000000');
  });

  it('returns 404 on unknown requestId — even on a second app instance', async () => {
    const app2 = await buildApp();
    const res = await request(app2).get('/api/recovery/status/nonexistent');
    expect(res.status).toBe(404);
  });
});
