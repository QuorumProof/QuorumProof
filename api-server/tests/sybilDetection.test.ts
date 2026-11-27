import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SybilDetectionService } from '../src/services/sybilDetection.js';
import sybilRouter from '../src/routes/sybilDetection.js';

describe('SybilDetectionService', () => {
  let sybilService: SybilDetectionService;

  beforeEach(() => {
    sybilService = new SybilDetectionService();
  });

  it('should record credential creation events', () => {
    sybilService.recordCredentialCreation('GA123');

    const activity = sybilService.getAccountActivity('GA123');
    expect(activity).toBeDefined();
    expect(activity?.credential_count).toBe(1);
    expect(activity?.address).toBe('GA123');
  });

  it('should increment credential count for repeated events', () => {
    sybilService.recordCredentialCreation('GA123');
    sybilService.recordCredentialCreation('GA123');
    sybilService.recordCredentialCreation('GA123');

    const activity = sybilService.getAccountActivity('GA123');
    expect(activity?.credential_count).toBe(3);
  });

  it('should generate Sybil score after recording event', () => {
    sybilService.recordCredentialCreation('GA123');

    const score = sybilService.getSybilScore('GA123');
    expect(score).toBeDefined();
    expect(score?.score).toBeGreaterThanOrEqual(0);
    expect(score?.score).toBeLessThanOrEqual(100);
    expect(score?.risk_level).toMatch(/low|medium|high|critical/);
  });

  it('should detect rapid credential creation', () => {
    const address = 'GA123';

    for (let i = 0; i < 6; i++) {
      sybilService.recordCredentialCreation(address);
    }

    const alerts = sybilService.getAlertsForAddress(address);
    const rapidCreationAlert = alerts.find(a => a.alert_type === 'rapid_creation');
    expect(rapidCreationAlert).toBeDefined();
    expect(rapidCreationAlert?.severity).toBe('high');
  });

  it('should flag high-score accounts as critical risk', () => {
    const address = 'GA123';

    for (let i = 0; i < 20; i++) {
      sybilService.recordCredentialCreation(address);
    }

    const score = sybilService.getSybilScore(address);
    expect(score?.score).toBeGreaterThan(70);
    expect(['high', 'critical']).toContain(score?.risk_level);
  });

  it('should calculate multiple risk factors', () => {
    sybilService.recordCredentialCreation('GA123');

    const score = sybilService.getSybilScore('GA123');
    expect(score?.factors).toHaveLength(4);
    expect(score?.factors.map(f => f.name)).toEqual([
      'creation_rate',
      'timing_pattern',
      'credential_volume',
      'recency',
    ]);
  });

  it('should dismiss alerts', () => {
    sybilService.recordCredentialCreation('GA123');
    sybilService.recordCredentialCreation('GA123');
    sybilService.recordCredentialCreation('GA123');
    sybilService.recordCredentialCreation('GA123');
    sybilService.recordCredentialCreation('GA123');
    sybilService.recordCredentialCreation('GA123');

    const alerts = sybilService.getAlertsForAddress('GA123');
    const firstAlert = alerts[0];

    const dismissed = sybilService.dismissAlert(firstAlert.alert_id);
    expect(dismissed).toBe(true);

    const remainingAlerts = sybilService.getAlertsForAddress('GA123');
    expect(remainingAlerts.length).toBeLessThan(alerts.length);
  });

  it('should identify high-risk accounts', () => {
    for (let i = 0; i < 15; i++) {
      sybilService.recordCredentialCreation('GA123');
    }

    const highRiskAccounts = sybilService.getHighRiskAccounts();
    const isHighRisk = highRiskAccounts.some(a => a.address === 'GA123');
    expect(isHighRisk).toBe(true);
  });

  it('should track multiple accounts independently', () => {
    sybilService.recordCredentialCreation('GA123');
    sybilService.recordCredentialCreation('GA123');

    for (let i = 0; i < 15; i++) {
      sybilService.recordCredentialCreation('GA456');
    }

    const activity123 = sybilService.getAccountActivity('GA123');
    const activity456 = sybilService.getAccountActivity('GA456');

    expect(activity123?.credential_count).toBe(2);
    expect(activity456?.credential_count).toBe(15);
  });

  it('should get all active alerts', () => {
    for (let i = 0; i < 6; i++) {
      sybilService.recordCredentialCreation('GA123');
      sybilService.recordCredentialCreation('GA456');
    }

    const allAlerts = sybilService.getAllActiveAlerts();
    expect(allAlerts.length).toBeGreaterThan(0);
  });

  it('should not find score for non-existent address', () => {
    const score = sybilService.getSybilScore('GA999');
    expect(score).toBeNull();
  });

  it('should not find activity for non-existent address', () => {
    const activity = sybilService.getAccountActivity('GA999');
    expect(activity).toBeNull();
  });

  it('should score factors with correct weights', () => {
    sybilService.recordCredentialCreation('GA123');

    const score = sybilService.getSybilScore('GA123');
    const totalWeight = score?.factors.reduce((sum, f) => sum + f.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 1);
  });
});

describe('sybilDetection routes validation (#1966)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/sybil', sybilRouter);

  it('rejects POST /record-event when address is missing', async () => {
    const res = await request(app).post('/api/sybil/record-event').send({});
    expect(res.status).toBe(400);
    expect(res.body.location).toBe('body');
    expect(res.body.details).toBeDefined();
  });

  it('rejects POST /record-event when address is empty or whitespace', async () => {
    const res = await request(app).post('/api/sybil/record-event').send({ address: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.location).toBe('body');
  });

  it('accepts POST /record-event with a valid address', async () => {
    const res = await request(app).post('/api/sybil/record-event').send({ address: 'GVALID123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.address).toBe('GVALID123');
  });

  it('rejects POST /dismiss-alert/:alert_id when alert_id is whitespace', async () => {
    const res = await request(app).post('/api/sybil/dismiss-alert/%20%20').send();
    expect(res.status).toBe(400);
    expect(res.body.location).toBe('params');
  });

  it('rejects POST /dismiss-alert/:alert_id when request body is non-empty', async () => {
    const res = await request(app)
      .post('/api/sybil/dismiss-alert/alert-1')
      .send({ unexpected: true });
    expect(res.status).toBe(400);
    expect(res.body.location).toBe('body');
  });

  it('accepts POST /dismiss-alert/:alert_id with valid param and empty body', async () => {
    const res = await request(app).post('/api/sybil/dismiss-alert/nonexistent-alert').send();
    expect(res.status).toBe(404);
  });
});
