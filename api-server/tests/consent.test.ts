/**
 * Tests for Credential Holder Consent Management Routes — Issue #1441 / #881
 *
 * Covers:
 *  - Grant creation (POST /api/credentials/:id/consent/grants)
 *  - Grant revocation (DELETE /api/credentials/:id/consent/grants/:verifier)
 *  - Specific grant retrieval (GET /api/credentials/:id/consent/grants/:verifier)
 *  - Grant status check: active vs inactive/revoked (GET /api/credentials/:id/consent/grants/:verifier/status)
 *  - Verifiers list (GET /api/credentials/:id/consent/verifiers)
 *  - Access log recording via bridge endpoint (POST /api/credentials/:id/consent/access)
 *  - Access log retrieval and filtering by verifier and access_type (GET /api/credentials/:id/consent/access-log)
 *  - Unauthorized attempts (403 on non-holder operations)
 *  - Credential not found (404) & input validation (400)
 *  - Cross-check: consent revocation blocking subsequent bridge access recorded via POST .../consent/access
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import consentRouter from '../src/routes/consent.js';
import * as soroban from '../src/soroban.js';

// Mock soroban module
vi.mock('../src/soroban.js', () => ({
  simulateCall: vi.fn(),
  u64Val: vi.fn((n: number | bigint) => n),
  u32Val: vi.fn((n: number) => n),
  addressVal: vi.fn((a: string) => a),
}));

describe('Consent Management Routes (/api/credentials/:id/consent)', () => {
  let app: express.Express;
  const mockSimulateCall = vi.mocked(soroban.simulateCall);

  const HOLDER_ADDR = 'GCLWGQBMKQL47Y6X7T3PBL43U6B6YTRQ54G42UGQ7WJ34N3C36Q4HOLDER';
  const OTHER_HOLDER_ADDR = 'GNOTMYCREDENTIALADDRESS123456789012345678901234567890123456';
  const VERIFIER_ADDR = 'GD7HQLV7P7MCRTXP3W5T546T3YHR3OBLGQ7Y5N3C36Q4VERIFIER1234567';

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/credentials', consentRouter);
  });

  // ---------------------------------------------------------------------------
  // 1. Validation & Credential ID resolution
  // ---------------------------------------------------------------------------
  describe('Input validation & ID parsing', () => {
    it('returns 400 when credential ID is invalid or non-positive', async () => {
      const res1 = await request(app).get('/api/credentials/abc/consent/verifiers?holder=' + HOLDER_ADDR);
      expect(res1.status).toBe(400);
      expect(res1.body.error).toBe('Invalid credential ID');

      const res2 = await request(app).get('/api/credentials/0/consent/verifiers?holder=' + HOLDER_ADDR);
      expect(res2.status).toBe(400);
      expect(res2.body.error).toBe('Invalid credential ID');

      const res3 = await request(app).get('/api/credentials/-5/consent/verifiers?holder=' + HOLDER_ADDR);
      expect(res3.status).toBe(400);
      expect(res3.body.error).toBe('Invalid credential ID');
    });

    it('returns 400 when holder query parameter is missing on verifier list', async () => {
      const res = await request(app).get('/api/credentials/1/consent/verifiers');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('holder query parameter');
    });

    it('returns 400 when holder query parameter is missing on access-log', async () => {
      const res = await request(app).get('/api/credentials/1/consent/access-log');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('holder query parameter');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Grant Creation (POST /:id/consent/grants)
  // ---------------------------------------------------------------------------
  describe('POST /api/credentials/:id/consent/grants', () => {
    it('grants consent to a verifier successfully (201)', async () => {
      mockSimulateCall.mockResolvedValueOnce(null);

      const expiresAt = Math.floor(Date.now() / 1000) + 86400;
      const res = await request(app)
        .post('/api/credentials/42/consent/grants')
        .send({
          holder: HOLDER_ADDR,
          verifier: VERIFIER_ADDR,
          expires_at: expiresAt,
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        credential_id: 42,
        holder: HOLDER_ADDR,
        verifier: VERIFIER_ADDR,
        expires_at: expiresAt,
        granted: true,
      });

      expect(mockSimulateCall).toHaveBeenCalledWith('grant_verifier_consent', [
        HOLDER_ADDR,
        VERIFIER_ADDR,
        42,
        expiresAt,
      ]);
    });

    it('defaults expires_at to 0 when omitted', async () => {
      mockSimulateCall.mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/credentials/42/consent/grants')
        .send({
          holder: HOLDER_ADDR,
          verifier: VERIFIER_ADDR,
        });

      expect(res.status).toBe(201);
      expect(res.body.expires_at).toBe(0);
      expect(mockSimulateCall).toHaveBeenCalledWith('grant_verifier_consent', [
        HOLDER_ADDR,
        VERIFIER_ADDR,
        42,
        0,
      ]);
    });

    it('returns 400 when holder or verifier is missing from request body', async () => {
      const missingHolder = await request(app)
        .post('/api/credentials/42/consent/grants')
        .send({ verifier: VERIFIER_ADDR });
      expect(missingHolder.status).toBe(400);
      expect(missingHolder.body.error).toContain('holder (Stellar address) is required');

      const missingVerifier = await request(app)
        .post('/api/credentials/42/consent/grants')
        .send({ holder: HOLDER_ADDR });
      expect(missingVerifier.status).toBe(400);
      expect(missingVerifier.body.error).toContain('verifier (Stellar address) is required');
    });

    it('returns 403 when non-holder attempts to grant consent (UnauthorizedAction)', async () => {
      mockSimulateCall.mockRejectedValueOnce(new Error('UnauthorizedAction: Caller is not the credential holder'));

      const res = await request(app)
        .post('/api/credentials/42/consent/grants')
        .send({
          holder: OTHER_HOLDER_ADDR,
          verifier: VERIFIER_ADDR,
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Only the credential holder may grant consent');
    });

    it('returns 404 when credential does not exist (CredentialNotFound)', async () => {
      mockSimulateCall.mockRejectedValueOnce(new Error('CredentialNotFound'));

      const res = await request(app)
        .post('/api/credentials/999/consent/grants')
        .send({
          holder: HOLDER_ADDR,
          verifier: VERIFIER_ADDR,
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Credential not found');
    });

    it('returns 400 when expires_at is invalid (InvalidInput)', async () => {
      mockSimulateCall.mockRejectedValueOnce(new Error('InvalidInput: expiry timestamp is in past'));

      const res = await request(app)
        .post('/api/credentials/42/consent/grants')
        .send({
          holder: HOLDER_ADDR,
          verifier: VERIFIER_ADDR,
          expires_at: 100,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('expires_at must be in the future');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Grant Revocation (DELETE /:id/consent/grants/:verifier)
  // ---------------------------------------------------------------------------
  describe('DELETE /api/credentials/:id/consent/grants/:verifier', () => {
    it('revokes consent for a verifier successfully', async () => {
      mockSimulateCall.mockResolvedValueOnce(null);

      const res = await request(app)
        .delete(`/api/credentials/42/consent/grants/${VERIFIER_ADDR}`)
        .send({ holder: HOLDER_ADDR });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        credential_id: 42,
        verifier: VERIFIER_ADDR,
        revoked: true,
      });

      expect(mockSimulateCall).toHaveBeenCalledWith('revoke_verifier_consent', [
        HOLDER_ADDR,
        VERIFIER_ADDR,
        42,
      ]);
    });

    it('returns 400 when holder is missing in request body', async () => {
      const res = await request(app)
        .delete(`/api/credentials/42/consent/grants/${VERIFIER_ADDR}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('holder (Stellar address) is required');
    });

    it('returns 403 when non-holder attempts revocation (UnauthorizedAction)', async () => {
      mockSimulateCall.mockRejectedValueOnce(new Error('UnauthorizedAction: Caller is not the credential holder'));

      const res = await request(app)
        .delete(`/api/credentials/42/consent/grants/${VERIFIER_ADDR}`)
        .send({ holder: OTHER_HOLDER_ADDR });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Only the credential holder may revoke consent');
    });

    it('returns 404 when credential is not found during revocation', async () => {
      mockSimulateCall.mockRejectedValueOnce(new Error('CredentialNotFound'));

      const res = await request(app)
        .delete(`/api/credentials/999/consent/grants/${VERIFIER_ADDR}`)
        .send({ holder: HOLDER_ADDR });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Credential not found');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Status Check & Specific Grant Retrieval
  // ---------------------------------------------------------------------------
  describe('Consent Status & Grant Details', () => {
    it('returns consent_active: true for an active consent grant', async () => {
      mockSimulateCall.mockResolvedValueOnce(true);

      const res = await request(app).get(`/api/credentials/42/consent/grants/${VERIFIER_ADDR}/status`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        credential_id: 42,
        verifier: VERIFIER_ADDR,
        consent_active: true,
      });
      expect(mockSimulateCall).toHaveBeenCalledWith('has_verifier_consent', [42, VERIFIER_ADDR]);
    });

    it('returns consent_active: false for revoked or expired consent', async () => {
      mockSimulateCall.mockResolvedValueOnce(false);

      const res = await request(app).get(`/api/credentials/42/consent/grants/${VERIFIER_ADDR}/status`);

      expect(res.status).toBe(200);
      expect(res.body.consent_active).toBe(false);
    });

    it('returns grant details with BigInt serialization', async () => {
      const grantData = {
        verifier: VERIFIER_ADDR,
        granted_at: 1700000000n,
        expires_at: 1800000000n,
        access_count: 5n,
      };
      mockSimulateCall.mockResolvedValueOnce(grantData);

      const res = await request(app).get(`/api/credentials/42/consent/grants/${VERIFIER_ADDR}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        verifier: VERIFIER_ADDR,
        granted_at: '1700000000',
        expires_at: '1800000000',
        access_count: '5',
      });
    });

    it('returns 404 when no grant exists for verifier', async () => {
      mockSimulateCall.mockResolvedValueOnce(null);

      const res = await request(app).get(`/api/credentials/42/consent/grants/${VERIFIER_ADDR}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No consent grant found for this verifier');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Verifiers Listing (GET /:id/consent/verifiers)
  // ---------------------------------------------------------------------------
  describe('GET /api/credentials/:id/consent/verifiers', () => {
    it('returns list of verifiers who accessed the credential', async () => {
      mockSimulateCall.mockResolvedValueOnce([
        { verifier: VERIFIER_ADDR, last_access: 1710000000n },
      ]);

      const res = await request(app).get(`/api/credentials/42/consent/verifiers?holder=${HOLDER_ADDR}`);

      expect(res.status).toBe(200);
      expect(res.body.credential_id).toBe(42);
      expect(res.body.total).toBe(1);
      expect(res.body.verifiers).toEqual([
        { verifier: VERIFIER_ADDR, last_access: '1710000000' },
      ]);
    });

    it('returns 403 when non-holder attempts to view verifiers list', async () => {
      mockSimulateCall.mockRejectedValueOnce(new Error('UnauthorizedAction'));

      const res = await request(app).get(`/api/credentials/42/consent/verifiers?holder=${OTHER_HOLDER_ADDR}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Only the credential holder may view this data');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Access Logging & Bridge Relaying (POST /:id/consent/access & GET .../access-log)
  // ---------------------------------------------------------------------------
  describe('Bridge Access Logging and Log Retrieval', () => {
    it('records an access event via POST /:id/consent/access', async () => {
      mockSimulateCall.mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/credentials/42/consent/access')
        .send({
          holder: HOLDER_ADDR,
          verifier: VERIFIER_ADDR,
          access_type: 1, // share_link
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        credential_id: 42,
        verifier: VERIFIER_ADDR,
        access_type: 1,
        access_type_label: 'share_link',
        recorded: true,
      });

      expect(mockSimulateCall).toHaveBeenCalledWith('record_verifier_access', [
        HOLDER_ADDR,
        42,
        VERIFIER_ADDR,
        1,
      ]);
    });

    it('returns 400 for invalid access_type code', async () => {
      const res = await request(app)
        .post('/api/credentials/42/consent/access')
        .send({
          holder: HOLDER_ADDR,
          verifier: VERIFIER_ADDR,
          access_type: 99,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('access_type must be 1 (share_link), 2 (delegation), or 3 (proof_request)');
    });

    it('retrieves and filters access log with human-readable labels', async () => {
      mockSimulateCall.mockResolvedValueOnce([
        { verifier: VERIFIER_ADDR, access_type: 1, timestamp: 1700000001n },
        { verifier: 'OTHER_VERIFIER', access_type: 2, timestamp: 1700000002n },
        { verifier: VERIFIER_ADDR, access_type: 3, timestamp: 1700000003n },
      ]);

      // Filter by verifier
      const res = await request(app).get(
        `/api/credentials/42/consent/access-log?holder=${HOLDER_ADDR}&verifier=${VERIFIER_ADDR}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.credential_id).toBe(42);
      expect(res.body.total).toBe(2);
      expect(res.body.entries).toHaveLength(2);
      expect(res.body.entries[0].access_type_label).toBe('share_link');
      expect(res.body.entries[1].access_type_label).toBe('proof_request');
    });

    it('filters access log by access_type', async () => {
      mockSimulateCall.mockResolvedValueOnce([
        { verifier: VERIFIER_ADDR, access_type: 1, timestamp: 1700000001n },
        { verifier: VERIFIER_ADDR, access_type: 2, timestamp: 1700000002n },
      ]);

      const res = await request(app).get(
        `/api/credentials/42/consent/access-log?holder=${HOLDER_ADDR}&access_type=2`,
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.entries[0].access_type).toBe(2);
      expect(res.body.entries[0].access_type_label).toBe('delegation');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Cross-Check: Revocation blocks subsequent bridge access recording
  // ---------------------------------------------------------------------------
  describe('Consent Revocation Enforcement Flow', () => {
    it('verifies that consent revocation blocks subsequent access recording attempts', async () => {
      // Step 1: Check initial consent status -> active
      mockSimulateCall.mockResolvedValueOnce(true);
      const statusBefore = await request(app).get(
        `/api/credentials/42/consent/grants/${VERIFIER_ADDR}/status`,
      );
      expect(statusBefore.status).toBe(200);
      expect(statusBefore.body.consent_active).toBe(true);

      // Step 2: Record access while consent is active -> succeeds
      mockSimulateCall.mockResolvedValueOnce(null);
      const accessBefore = await request(app)
        .post('/api/credentials/42/consent/access')
        .send({
          holder: HOLDER_ADDR,
          verifier: VERIFIER_ADDR,
          access_type: 3, // proof_request
        });
      expect(accessBefore.status).toBe(201);
      expect(accessBefore.body.recorded).toBe(true);

      // Step 3: Revoke consent
      mockSimulateCall.mockResolvedValueOnce(null);
      const revokeRes = await request(app)
        .delete(`/api/credentials/42/consent/grants/${VERIFIER_ADDR}`)
        .send({ holder: HOLDER_ADDR });
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.revoked).toBe(true);

      // Step 4: Check consent status -> inactive
      mockSimulateCall.mockResolvedValueOnce(false);
      const statusAfter = await request(app).get(
        `/api/credentials/42/consent/grants/${VERIFIER_ADDR}/status`,
      );
      expect(statusAfter.status).toBe(200);
      expect(statusAfter.body.consent_active).toBe(false);

      // Step 5: Subsequent access recording is blocked by contract (UnauthorizedAction) -> 403
      mockSimulateCall.mockRejectedValueOnce(
        new Error('UnauthorizedAction: Verifier consent is not active or has been revoked'),
      );
      const accessAfter = await request(app)
        .post('/api/credentials/42/consent/access')
        .send({
          holder: HOLDER_ADDR,
          verifier: VERIFIER_ADDR,
          access_type: 3,
        });

      expect(accessAfter.status).toBe(403);
      expect(accessAfter.body.error).toBe('Only the credential holder may record access events');
    });
  });
});
