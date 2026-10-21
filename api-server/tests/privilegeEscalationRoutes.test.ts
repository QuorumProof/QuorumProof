import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import privilegeEscalationRouter from '../src/routes/privilegeEscalation.js';

const app = express();
app.use(express.json());
app.use('/privilege-escalation', privilegeEscalationRouter);

describe('privilege escalation route validation', () => {
  it.each([
    ['/mfa-challenge', { userId: {} }],
    ['/verify-mfa', { userId: 'user-1', code: '123' }],
    ['/request', { userId: 'user-1', newRole: 'admin', approvers: 'approver-1' }],
    ['/approve', { requestId: {}, approverId: 'approver-1' }],
    ['/reject', { requestId: 'request-1', approverId: 'approver-1', reason: {} }],
  ])('rejects invalid input for %s before handling', async (path, body) => {
    const response = await request(app).post(`/privilege-escalation${path}`).send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });
});
