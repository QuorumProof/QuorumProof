/**
 * Tests for Issue #1428 — RFC 9457 Problem Details error shape consistency.
 *
 * Asserts that:
 *  1. problemJson() produces a well-formed ProblemDetails object.
 *  2. Routes that have adopted the shared formatter (costs, privilegeEscalation)
 *     return the expected Problem Details shape on error paths.
 *  3. v1 backward-compatibility: the `error` alias field is always present.
 *  4. Content-Type is set to application/problem+json when sendProblem() is used.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { problemJson, sendProblem, problemDetailsErrorHandler } from '../src/middleware/problemDetails.js';

// ---------------------------------------------------------------------------
// Unit tests for problemJson()
// ---------------------------------------------------------------------------

describe('problemJson() shape', () => {
  it('returns required RFC 9457 fields', () => {
    const p = problemJson(404, 'not-found', 'Resource not found');

    expect(p.type).toBe('https://quorumproof.io/errors/not-found');
    expect(p.title).toBe('Not Found');
    expect(p.status).toBe(404);
    expect(p.detail).toBe('Resource not found');
  });

  it('includes v1 backward-compat `error` alias equal to `detail`', () => {
    const p = problemJson(400, 'bad-request', 'Invalid input');
    expect(p.error).toBe(p.detail);
  });

  it('merges extra fields without overwriting required ones', () => {
    const p = problemJson(422, 'validation-failed', 'Missing field', { field: 'userId' });
    expect(p.field).toBe('userId');
    expect(p.type).toBe('https://quorumproof.io/errors/validation-failed');
  });

  it('uses default title for unknown status codes', () => {
    const p = problemJson(418, 'teapot', "I'm a teapot");
    expect(p.title).toBe('Error'); // falls back to 'Error'
  });

  it('uses correct title for all standard codes', () => {
    const cases: Array<[number, string]> = [
      [400, 'Bad Request'],
      [401, 'Unauthorized'],
      [403, 'Forbidden'],
      [404, 'Not Found'],
      [409, 'Conflict'],
      [410, 'Gone'],
      [429, 'Too Many Requests'],
      [500, 'Internal Server Error'],
    ];
    for (const [status, title] of cases) {
      expect(problemJson(status, 'test', 'msg').title).toBe(title);
    }
  });
});

// ---------------------------------------------------------------------------
// sendProblem() sets the correct Content-Type header
// ---------------------------------------------------------------------------

describe('sendProblem() Content-Type', () => {
  it('sets Content-Type to application/problem+json', async () => {
    const app = express();
    app.get('/test', (_req, res) => {
      sendProblem(res, problemJson(404, 'not-found', 'Test'));
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.type).toBe('https://quorumproof.io/errors/not-found');
    expect(res.body.error).toBe('Test'); // v1 compat
  });
});

// ---------------------------------------------------------------------------
// problemDetailsErrorHandler() — global error handler
// ---------------------------------------------------------------------------

describe('problemDetailsErrorHandler()', () => {
  it('converts a thrown Error to Problem Details', async () => {
    const app = express();
    app.get('/boom', () => { throw new Error('Something exploded'); });
    app.use(problemDetailsErrorHandler);

    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.type).toBe('https://quorumproof.io/errors/internal-server-error');
    expect(res.body.detail).toBe('Something exploded');
    expect(res.body.error).toBe('Something exploded');
  });

  it('respects a custom status code on the error object', async () => {
    const app = express();
    app.get('/conflict', (_req, _res, next) => {
      const err = Object.assign(new Error('Already exists'), { status: 409, slug: 'already-exists' });
      next(err);
    });
    app.use(problemDetailsErrorHandler);

    const res = await request(app).get('/conflict');
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('https://quorumproof.io/errors/already-exists');
    expect(res.body.title).toBe('Conflict');
  });
});

// ---------------------------------------------------------------------------
// costs.ts — error responses use Problem Details
// ---------------------------------------------------------------------------

// costs.ts depends on gasCostTracker, which is not relevant here — mock it.
vi.mock('../src/services/gasCostTracker.js', () => ({
  getDefaultGasCostTracker: () => ({
    getReport: () => ({}),
    getOptimizationRecommendations: () => [],
    project: (_op: string, _cpd: number, _d: number) => null, // simulate "not found"
  }),
}));

import costsRouter from '../src/routes/costs.js';

const costsApp = express();
costsApp.use(express.json());
costsApp.use('/api/costs', costsRouter);

describe('costs.ts — Problem Details error shape', () => {
  it('returns 400 Problem Details when operation param is missing', async () => {
    const res = await request(costsApp).get('/api/costs/projection');
    expect(res.status).toBe(400);
    expect(res.body.type).toMatch(/missing-parameter/);
    expect(res.body.status).toBe(400);
    expect(res.body.detail).toBeTruthy();
    expect(typeof res.body.error).toBe('string'); // v1 compat
  });

  it('returns 400 Problem Details when callsPerDay is invalid', async () => {
    const res = await request(costsApp).get('/api/costs/projection?operation=foo&callsPerDay=bad');
    expect(res.status).toBe(400);
    expect(res.body.type).toMatch(/invalid-parameter/);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 404 Problem Details when operation has no data', async () => {
    const res = await request(costsApp).get('/api/costs/projection?operation=missing_op&callsPerDay=100');
    expect(res.status).toBe(404);
    expect(res.body.type).toMatch(/not-found/);
    expect(res.body.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// privilegeEscalation.ts — error responses use Problem Details
// ---------------------------------------------------------------------------

vi.mock('../src/services/privilegeEscalationPrevention.js', () => ({
  privilegeEscalationManager: {
    requireMFAForEscalation: (_userId: string) => ({ expiresAt: Date.now() + 60000 }),
    verifyMFACode: (_userId: string, _code: string) => false,
    submitApprovalRequest: () => 'req-001',
    approvePrivilegeChange: (_rid: string, _aid: string) => false,
    rejectPrivilegeChange: (_rid: string, _aid: string, _r?: string) => false,
    getAuditLog: () => [],
    getPendingApprovals: () => [],
  },
}));

vi.mock('../src/services/logger.js', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import privilegeEscalationRouter from '../src/routes/privilegeEscalation.js';

const peApp = express();
peApp.use(express.json());
peApp.use('/api/admin/privilege-escalation', privilegeEscalationRouter);

describe('privilegeEscalation.ts — Problem Details error shape', () => {
  it('returns 400 Problem Details when userId is missing from mfa-challenge', async () => {
    const res = await request(peApp).post('/api/admin/privilege-escalation/mfa-challenge').send({});
    expect(res.status).toBe(400);
    expect(res.body.type).toMatch(/missing-parameter/);
    expect(res.body.status).toBe(400);
    expect(typeof res.body.error).toBe('string'); // v1 compat
  });

  it('returns 400 Problem Details when userId/code is missing from verify-mfa', async () => {
    const res = await request(peApp).post('/api/admin/privilege-escalation/verify-mfa').send({ userId: 'alice' });
    expect(res.status).toBe(400);
    expect(res.body.type).toMatch(/missing-parameter/);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 401 Problem Details for invalid MFA code', async () => {
    const res = await request(peApp)
      .post('/api/admin/privilege-escalation/verify-mfa')
      .send({ userId: 'alice', code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.type).toMatch(/invalid-mfa-code/);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 404 Problem Details when approve request is not found', async () => {
    const res = await request(peApp)
      .post('/api/admin/privilege-escalation/approve')
      .send({ requestId: 'req-xyz', approverId: 'alice' });
    expect(res.status).toBe(404);
    expect(res.body.type).toMatch(/not-found/);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 404 Problem Details when reject request is not found', async () => {
    const res = await request(peApp)
      .post('/api/admin/privilege-escalation/reject')
      .send({ requestId: 'req-xyz', approverId: 'alice' });
    expect(res.status).toBe(404);
    expect(res.body.type).toMatch(/not-found/);
    expect(res.body.error).toBeTruthy();
  });
});
