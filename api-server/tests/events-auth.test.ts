/**
 * Auth + caller-scoping tests for /api/events — issue #1746.
 *
 *  - /recent and /range require a valid bearer token (401 otherwise)
 *  - non-admin callers only receive events where they are issuer or holder
 *  - admins receive every event
 *  - /ws-info stays public (protocol metadata only)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEventsRouter } from '../src/routes/events.js';
import { credentialEventService } from '../src/services/credentialEvents.js';
import {
  SessionManager,
  _setDefaultSessionManagerForTest,
  _resetDefaultSessionManagerForTest,
} from '../src/services/sessionManager.js';

vi.mock('../src/ws/server.js', () => ({
  broadcastEvent: vi.fn(() => 0),
}));

const ISSUER_A = 'GISSUER_A_1746';
const HOLDER_A = 'GHOLDER_A_1746';
const ISSUER_B = 'GISSUER_B_1746';
const HOLDER_B = 'GHOLDER_B_1746';

describe('Events routes auth (#1746)', () => {
  let tempDir: string;
  let mgr: SessionManager;
  let app: express.Express;

  const tokenFor = (sub: string, role?: string) =>
    `Bearer ${mgr.createSession(sub, { role, mfaVerified: true }).accessToken}`;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-events-1746';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-auth-'));
    mgr = new SessionManager({ dataDir: tempDir });
    _setDefaultSessionManagerForTest(mgr);

    credentialEventService.emitCredentialIssued(1746001, ISSUER_A, HOLDER_A);
    credentialEventService.emitCredentialIssued(1746002, ISSUER_B, HOLDER_B);

    app = express();
    app.use(express.json());
    app.use('/api/events', createEventsRouter());
  });

  afterEach(() => {
    _resetDefaultSessionManagerForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.JWT_SECRET;
  });

  describe('unauthenticated access', () => {
    it('rejects /recent without a token', async () => {
      const res = await request(app).get('/api/events/recent');
      expect(res.status).toBe(401);
      expect(res.body.events).toBeUndefined();
    });

    it('rejects /range without a token', async () => {
      const res = await request(app).get('/api/events/range');
      expect(res.status).toBe(401);
      expect(res.body.events).toBeUndefined();
    });

    it('rejects a forged or malformed token', async () => {
      const res = await request(app)
        .get('/api/events/recent')
        .set('Authorization', 'Bearer not.a.jwt');
      expect(res.status).toBe(401);
    });

    it('keeps /ws-info public', async () => {
      const res = await request(app).get('/api/events/ws-info');
      expect(res.status).toBe(200);
      expect(res.body.endpoint).toBeDefined();
    });
  });

  describe('caller-scoped payloads', () => {
    it('returns only the caller’s events on /recent for a non-admin', async () => {
      const res = await request(app)
        .get('/api/events/recent?limit=1000')
        .set('Authorization', tokenFor(ISSUER_A, 'issuer'));

      expect(res.status).toBe(200);
      const ids = res.body.events.map((e: { credential_id: number }) => e.credential_id);
      expect(ids).toContain(1746001);
      expect(ids).not.toContain(1746002);
      for (const e of res.body.events) {
        expect([e.issuer, e.holder]).toContain(ISSUER_A);
      }
    });

    it('lets a holder see credentials issued to them', async () => {
      const res = await request(app)
        .get('/api/events/recent?limit=1000')
        .set('Authorization', tokenFor(HOLDER_B, 'verifier'));

      const ids = res.body.events.map((e: { credential_id: number }) => e.credential_id);
      expect(ids).toContain(1746002);
      expect(ids).not.toContain(1746001);
    });

    it('filters /range the same way for a non-admin', async () => {
      const start = new Date(Date.now() - 60_000).toISOString();
      const end = new Date(Date.now() + 60_000).toISOString();
      const res = await request(app)
        .get(`/api/events/range?start_time=${start}&end_time=${end}`)
        .set('Authorization', tokenFor('GSTRANGER_1746', 'verifier'));

      expect(res.status).toBe(200);
      const ids = res.body.events.map((e: { credential_id: number }) => e.credential_id);
      expect(ids).not.toContain(1746001);
      expect(ids).not.toContain(1746002);
    });

    it('returns unfiltered events to an admin', async () => {
      const res = await request(app)
        .get('/api/events/recent?limit=1000')
        .set('Authorization', tokenFor('GADMIN_1746', 'admin'));

      expect(res.status).toBe(200);
      const ids = res.body.events.map((e: { credential_id: number }) => e.credential_id);
      expect(ids).toContain(1746001);
      expect(ids).toContain(1746002);
    });

    it('ignores an x-role header when no JWT is presented', async () => {
      // A caller asserting role=admin in a header without a JWT must still be rejected.
      const res = await request(app)
        .get('/api/events/recent')
        .set('x-role', 'admin');
      expect(res.status).toBe(401);
    });
  });
});
