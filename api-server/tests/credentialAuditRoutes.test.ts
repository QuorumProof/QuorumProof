import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { CredentialAuditTrail, type CredentialChange } from '../src/services/credentialAuditTrail.js';
import { createAuditRouter } from '../src/routes/credentialAudit.js';

const changedAt = Date.parse('2026-01-02T03:04:05.000Z');
const change: CredentialChange = {
  change_id: 'change-1',
  credential_id: 42n,
  field_name: 'status',
  old_value: 'pending',
  new_value: 'active',
  changed_at: changedAt,
  changed_by: 'GUSER123',
  change_reason: 'approved',
  hash: 'hash-1',
};

const getChangeHistory = vi.spyOn(CredentialAuditTrail.prototype, 'getChangeHistory');
const getFieldHistory = vi.spyOn(CredentialAuditTrail.prototype, 'getFieldHistory');
const getChangesByUser = vi.spyOn(CredentialAuditTrail.prototype, 'getChangesByUser');
const generateAuditReport = vi.spyOn(CredentialAuditTrail.prototype, 'generateAuditReport');
const detectAnomalies = vi.spyOn(CredentialAuditTrail.prototype, 'detectAnomalies');

const app = express();
app.use('/api/credentials', createAuditRouter());

describe('credential audit routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChangeHistory.mockResolvedValue({
      changes: [change],
      integrity_verified: true,
      last_verified_at: changedAt,
    });
    getFieldHistory.mockResolvedValue([change]);
    getChangesByUser.mockResolvedValue([change]);
    generateAuditReport.mockResolvedValue({
      credential_id: '42',
      total_changes: 1,
      unique_changers: 1,
      date_range: { from: new Date(changedAt).toISOString(), to: new Date(changedAt).toISOString() },
      integrity_status: 'verified',
      anomalies: [{ type: 'rapid_changes', description: 'Changes were unusually rapid' }],
      changes: [change],
    });
    detectAnomalies.mockReturnValue([
      { type: 'value_reversal', description: 'Field was reverted', change_ids: ['change-1'] },
    ]);
  });

  it('returns the credential change history and integrity summary', async () => {
    const res = await request(app).get('/api/credentials/42/audit');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      credential_id: '42',
      summary: { total_changes: 1, integrity_verified: true },
      changes: [{
        change_id: 'change-1',
        field_name: 'status',
        changed_at: new Date(changedAt).toISOString(),
        changed_by: 'GUSER123',
      }],
    });
    expect(getChangeHistory).toHaveBeenCalledWith(42n);
  });

  it('returns history for the requested field', async () => {
    const res = await request(app).get('/api/credentials/42/audit/field/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      credential_id: '42',
      field_name: 'status',
      total_changes: 1,
      changes: [{ old_value: 'pending', new_value: 'active' }],
    });
    expect(getFieldHistory).toHaveBeenCalledWith(42n, 'status');
  });

  it('returns changes made by the requested user', async () => {
    const res = await request(app).get('/api/credentials/42/audit/user/GUSER123');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      credential_id: '42',
      user_address: 'GUSER123',
      total_changes: 1,
      changes: [{ field_name: 'status', old_value: 'pending', new_value: 'active' }],
    });
    expect(getChangesByUser).toHaveBeenCalledWith(42n, 'GUSER123');
  });

  it('returns the comprehensive audit report', async () => {
    const res = await request(app).get('/api/credentials/42/audit/report');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      credential_id: '42',
      audit_summary: {
        total_changes: 1,
        unique_changers: 1,
        integrity_status: 'verified',
        anomalies_count: 1,
      },
      anomalies: [{ type: 'rapid_changes' }],
      change_summary: [{ change_id: 'change-1', field_name: 'status' }],
    });
    expect(generateAuditReport).toHaveBeenCalledWith(42n);
  });

  it('returns detected anomalies and severity', async () => {
    const res = await request(app).get('/api/credentials/42/audit/anomalies');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      credential_id: '42',
      total_anomalies_detected: 1,
      has_anomalies: true,
      anomalies: [{ type: 'value_reversal', severity: 'medium' }],
    });
    expect(detectAnomalies).toHaveBeenCalledWith([change]);
  });

  it('reports tampered integrity status', async () => {
    getChangeHistory.mockResolvedValueOnce({
      changes: [change],
      integrity_verified: false,
      last_verified_at: changedAt,
    });

    const res = await request(app).get('/api/credentials/42/audit/integrity');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      credential_id: '42',
      integrity_verified: false,
      integrity_status: 'TAMPERED',
      total_changes_verified: 1,
      warning: expect.stringContaining('Hash mismatch'),
    });
  });

  it('returns a server error when history retrieval fails', async () => {
    getChangeHistory.mockRejectedValueOnce(new Error('database unavailable'));

    const res = await request(app).get('/api/credentials/invalid/audit');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: 'Failed to retrieve change history',
      message: expect.any(String),
    });
  });
});
