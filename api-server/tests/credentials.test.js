/**
 * credentials.test.js — tests for issues #470 and #471
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/index.js';
import { credentials } from '../src/credentials.js';

const VALID_ISSUE_BODY = {
  subject: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN',
  issuer: 'GBAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN',
  credential_type: 1,
  metadata_hash: 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',
};

beforeEach(() => {
  credentials.clear();
});

// ── POST /api/credentials/issue (#471) ────────────────────────────────────────

describe('POST /api/credentials/issue', () => {
  it('issues a credential and returns credential_id', async () => {
    const res = await request(app).post('/api/credentials/issue').send(VALID_ISSUE_BODY);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('credential_id');
  });

  it('returns 400 when subject is missing', async () => {
    const { subject: _, ...body } = VALID_ISSUE_BODY;
    const res = await request(app).post('/api/credentials/issue').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/subject/);
  });

  it('returns 400 when credential_type is missing', async () => {
    const { credential_type: _, ...body } = VALID_ISSUE_BODY;
    const res = await request(app).post('/api/credentials/issue').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/credential_type/);
  });

  it('returns 400 when metadata_hash is missing', async () => {
    const { metadata_hash: _, ...body } = VALID_ISSUE_BODY;
    const res = await request(app).post('/api/credentials/issue').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metadata_hash/);
  });

  it('assigns unique IDs to successive credentials', async () => {
    const r1 = await request(app).post('/api/credentials/issue').send(VALID_ISSUE_BODY);
    const r2 = await request(app).post('/api/credentials/issue').send(VALID_ISSUE_BODY);
    expect(r1.body.credential_id).not.toBe(r2.body.credential_id);
  });
});

// ── POST /api/credentials/:id/verify (#470) ───────────────────────────────────

describe('POST /api/credentials/:id/verify', () => {
  it('verifies an existing credential', async () => {
    const issue = await request(app).post('/api/credentials/issue').send(VALID_ISSUE_BODY);
    const id = issue.body.credential_id;

    const res = await request(app)
      .post(`/api/credentials/${id}/verify`)
      .send({ verifier_address: 'GCAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN' });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.credential_id).toBe(id);
    expect(res.body).toHaveProperty('attestors');
  });

  it('returns 404 for unknown credential', async () => {
    const res = await request(app)
      .post('/api/credentials/9999/verify')
      .send({ verifier_address: 'GCAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when verifier_address is missing', async () => {
    const issue = await request(app).post('/api/credentials/issue').send(VALID_ISSUE_BODY);
    const id = issue.body.credential_id;

    const res = await request(app).post(`/api/credentials/${id}/verify`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verifier_address/);
  });

  it('includes delegation_proof_provided flag when proof is supplied', async () => {
    const issue = await request(app).post('/api/credentials/issue').send(VALID_ISSUE_BODY);
    const id = issue.body.credential_id;

    const res = await request(app)
      .post(`/api/credentials/${id}/verify`)
      .send({ verifier_address: 'GCAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN', delegation_proof: 'abc123' });

    expect(res.body.delegation_proof_provided).toBe(true);
  });

  it('returns verified:false for a revoked credential', async () => {
    const issue = await request(app).post('/api/credentials/issue').send(VALID_ISSUE_BODY);
    const id = issue.body.credential_id;
    credentials.get(id).revoked = true;

    const res = await request(app)
      .post(`/api/credentials/${id}/verify`)
      .send({ verifier_address: 'GCAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN' });

    expect(res.body.verified).toBe(false);
    expect(res.body.reason).toBe('revoked');
  });
});
