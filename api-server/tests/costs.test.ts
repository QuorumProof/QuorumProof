/**
 * Tests for Gas Cost Reporting Routes — Issue #1440 / #4
 *
 * Covers:
 *  - GET /api/costs/report (empty report, aggregated operation statistics, XLM/USD conversion)
 *  - GET /api/costs/optimizations (valid top=N, invalid N fallback, recommendations format)
 *  - GET /api/costs/projection (missing operation 400, invalid callsPerDay 400, 404 for unrecorded operations, happy-path calculations)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import costsRouter from '../src/routes/costs.js';
import {
  GasCostTracker,
  _setDefaultGasCostTrackerForTest,
} from '../src/services/gasCostTracker.js';

describe('Gas Cost Routes (/api/costs)', () => {
  let app: express.Express;
  let tempDir: string;
  let tracker: GasCostTracker;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'costs-test-'));
    process.env.XLM_USD_PRICE = '0.15';

    tracker = new GasCostTracker(tempDir);
    _setDefaultGasCostTrackerForTest(tracker);

    app = express();
    app.use(express.json());
    app.use('/api/costs', costsRouter);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
    _setDefaultGasCostTrackerForTest(undefined);
    delete process.env.XLM_USD_PRICE;
  });

  // ---------------------------------------------------------------------------
  // 1. GET /api/costs/report
  // ---------------------------------------------------------------------------
  describe('GET /api/costs/report', () => {
    it('returns default empty report when no operations have been recorded', async () => {
      const res = await request(app).get('/api/costs/report');

      expect(res.status).toBe(200);
      expect(res.body.generatedAt).toBeDefined();
      expect(res.body.xlmUsdPrice).toBe(0.15);
      expect(res.body.totalCalls).toBe(0);
      expect(res.body.totalStroops).toBe('0');
      expect(res.body.totalXlm).toBe(0);
      expect(res.body.totalUsd).toBe(0);
      expect(res.body.byOperation).toEqual([]);
    });

    it('returns aggregated gas cost report with correct calculations and sorting', async () => {
      // 10,000,000 stroops = 1 XLM
      tracker.record('is_attested', '10000000');
      tracker.record('is_attested', '30000000'); // total 40,000,000 stroops = 4 XLM, avg 20,000,000
      tracker.record('issue_credential', '100000000'); // 100,000,000 stroops = 10 XLM
      tracker.record('revoke_credential', '20000000'); // 20,000,000 stroops = 2 XLM

      const res = await request(app).get('/api/costs/report');

      expect(res.status).toBe(200);
      expect(res.body.totalCalls).toBe(4);
      expect(res.body.totalStroops).toBe('160000000'); // 160M stroops = 16 XLM
      expect(res.body.totalXlm).toBe(16);
      expect(res.body.totalUsd).toBeCloseTo(16 * 0.15, 4);

      // Operations must be sorted by totalStroops descending
      expect(res.body.byOperation).toHaveLength(3);
      expect(res.body.byOperation[0].operation).toBe('issue_credential');
      expect(res.body.byOperation[0].callCount).toBe(1);
      expect(res.body.byOperation[0].totalStroops).toBe('100000000');

      expect(res.body.byOperation[1].operation).toBe('is_attested');
      expect(res.body.byOperation[1].callCount).toBe(2);
      expect(res.body.byOperation[1].totalStroops).toBe('40000000');
      expect(res.body.byOperation[1].minStroops).toBe('10000000');
      expect(res.body.byOperation[1].maxStroops).toBe('30000000');
      expect(res.body.byOperation[1].avgStroops).toBe('20000000');

      expect(res.body.byOperation[2].operation).toBe('revoke_credential');
      expect(res.body.byOperation[2].callCount).toBe(1);
      expect(res.body.byOperation[2].totalStroops).toBe('20000000');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. GET /api/costs/optimizations
  // ---------------------------------------------------------------------------
  describe('GET /api/costs/optimizations', () => {
    it('returns empty recommendations when no operations are recorded', async () => {
      const res = await request(app).get('/api/costs/optimizations');

      expect(res.status).toBe(200);
      expect(res.body.recommendations).toEqual([]);
    });

    it('returns ranked recommendations with valid top=N parameter', async () => {
      tracker.record('verify_batch', '500000000'); // 50 XLM (heavy contribution)
      tracker.record('issue_credential', '100000000');
      tracker.record('is_attested', '10000000');

      const res = await request(app).get('/api/costs/optimizations?top=2');

      expect(res.status).toBe(200);
      expect(res.body.recommendations).toHaveLength(2);
      expect(res.body.recommendations[0].operation).toBe('verify_batch');
      expect(res.body.recommendations[0].totalXlmContribution).toBe(50);
      expect(res.body.recommendations[0].reason).toContain('Accounts for');
      expect(res.body.recommendations[1].operation).toBe('issue_credential');
    });

    it('falls back gracefully to default top=5 when top query param is non-numeric or invalid', async () => {
      tracker.record('op1', '10000000');
      tracker.record('op2', '20000000');

      const res = await request(app).get('/api/costs/optimizations?top=invalid-value');

      expect(res.status).toBe(200);
      expect(res.body.recommendations).toBeInstanceOf(Array);
      expect(res.body.recommendations.length).toBeLessThanOrEqual(5);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. GET /api/costs/projection
  // ---------------------------------------------------------------------------
  describe('GET /api/costs/projection', () => {
    it('returns 400 when operation query parameter is missing', async () => {
      const res = await request(app).get('/api/costs/projection?callsPerDay=1000&days=30');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('operation query param is required');
    });

    it('returns 400 when callsPerDay is missing or not a positive number', async () => {
      const missingCalls = await request(app).get('/api/costs/projection?operation=is_attested');
      expect(missingCalls.status).toBe(400);
      expect(missingCalls.body.error).toBe('callsPerDay must be a positive number');

      const zeroCalls = await request(app).get('/api/costs/projection?operation=is_attested&callsPerDay=0');
      expect(zeroCalls.status).toBe(400);
      expect(zeroCalls.body.error).toBe('callsPerDay must be a positive number');

      const negativeCalls = await request(app).get('/api/costs/projection?operation=is_attested&callsPerDay=-50');
      expect(negativeCalls.status).toBe(400);
      expect(negativeCalls.body.error).toBe('callsPerDay must be a positive number');

      const nonNumericCalls = await request(app).get('/api/costs/projection?operation=is_attested&callsPerDay=abc');
      expect(nonNumericCalls.status).toBe(400);
      expect(nonNumericCalls.body.error).toBe('callsPerDay must be a positive number');
    });

    it('returns 404 when operation has no recorded cost data', async () => {
      const res = await request(app).get('/api/costs/projection?operation=non_existent_op&callsPerDay=1000&days=30');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No recorded cost data for operation "non_existent_op" yet');
    });

    it('calculates cost projection correctly on happy path with custom days', async () => {
      // 10,000,000 stroops (1 XLM) avg per call
      tracker.record('is_attested', '10000000');

      // 1,000 calls/day * 30 days = 30,000 calls
      // 30,000 calls * 10,000,000 stroops = 300,000,000,000 stroops = 30,000 XLM
      // 30,000 XLM * $0.15 = $4,500 USD
      const res = await request(app).get('/api/costs/projection?operation=is_attested&callsPerDay=1000&days=30');

      expect(res.status).toBe(200);
      expect(res.body.operation).toBe('is_attested');
      expect(res.body.callsPerDay).toBe(1000);
      expect(res.body.days).toBe(30);
      expect(res.body.basedOnAvgStroops).toBe('10000000');
      expect(res.body.projectedStroops).toBe('300000000000');
      expect(res.body.projectedXlm).toBe(30000);
      expect(res.body.projectedUsd).toBeCloseTo(4500, 2);
    });

    it('defaults days to 30 when days parameter is omitted', async () => {
      tracker.record('is_attested', '10000000');

      const res = await request(app).get('/api/costs/projection?operation=is_attested&callsPerDay=500');

      expect(res.status).toBe(200);
      expect(res.body.days).toBe(30);
      expect(res.body.projectedXlm).toBe(15000);
    });
  });
});
