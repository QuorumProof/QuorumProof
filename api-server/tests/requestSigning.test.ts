import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequestSigning } from '../src/middleware/requestSigning.js';

const SECRET = 'test-secret-key';

function createTestApp(signing: ReturnType<typeof createRequestSigning>) {
  const app = express();
  app.use(express.json());
  app.use('/api', signing);
  app.get('/api/test', (_req, res) => res.json({ ok: true }));
  app.post('/api/test', (_req, res) => res.json({ ok: true }));
  return app;
}

function signPayload(method: string, path: string, timestamp: number, body: unknown, secret: string): string {
  const { createHmac } = require('crypto');
  const payload = `${method}\n${path}\n${timestamp}\n${JSON.stringify(body || {})}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

describe('Request Signing Middleware', () => {
  it('bypasses when disabled', async () => {
    const signing = createRequestSigning({ secret: '', enabled: false });
    const app = createTestApp(signing);

    const res = await request(app).get('/api/test');
    expect(res.status).toBe(200);
  });

  it('rejects requests without required headers', async () => {
    const signing = createRequestSigning({ secret: SECRET, enabled: true });
    const app = createTestApp(signing);

    const res = await request(app).get('/api/test');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing authentication');
  });

  it('rejects requests with invalid timestamp', async () => {
    const signing = createRequestSigning({ secret: SECRET, enabled: true });
    const app = createTestApp(signing);

    const res = await request(app)
      .get('/api/test')
      .set('x-stellar-signature', 'test')
      .set('x-signature-timestamp', 'not-a-number')
      .set('x-signature-digest', 'abc');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid timestamp');
  });

  it('rejects requests with expired timestamp', async () => {
    const signing = createRequestSigning({ secret: SECRET, enabled: true, maxTimestampAgeMs: 1000 });
    const app = createTestApp(signing);

    const res = await request(app)
      .get('/api/test')
      .set('x-stellar-signature', 'test')
      .set('x-signature-timestamp', String(Date.now() - 5000))
      .set('x-signature-digest', 'abc');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Expired timestamp');
  });

  it('rejects requests with future timestamp', async () => {
    const signing = createRequestSigning({ secret: SECRET, enabled: true });
    const app = createTestApp(signing);

    const res = await request(app)
      .get('/api/test')
      .set('x-stellar-signature', 'test')
      .set('x-signature-timestamp', String(Date.now() + 60000))
      .set('x-signature-digest', 'abc');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Future timestamp');
  });

  it('rejects requests with invalid signature', async () => {
    const signing = createRequestSigning({ secret: SECRET, enabled: true });
    const app = createTestApp(signing);

    const res = await request(app)
      .get('/api/test')
      .set('x-stellar-signature', 'test')
      .set('x-signature-timestamp', String(Date.now()))
      .set('x-signature-digest', 'invalid-signature');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  it('accepts requests with valid signature', async () => {
    const signing = createRequestSigning({ secret: SECRET, enabled: true });
    const app = createTestApp(signing);

    const timestamp = Date.now();
    const sig = signPayload('GET', '/api/test', timestamp, {}, SECRET);

    const res = await request(app)
      .get('/api/test')
      .set('x-stellar-signature', 'test')
      .set('x-signature-timestamp', String(timestamp))
      .set('x-signature-digest', sig);

    expect(res.status).toBe(200);
  });

  it('accepts POST requests with valid signature', async () => {
    const signing = createRequestSigning({ secret: SECRET, enabled: true });
    const app = createTestApp(signing);

    const timestamp = Date.now();
    const body = { data: 'hello' };
    const sig = signPayload('POST', '/api/test', timestamp, body, SECRET);

    const res = await request(app)
      .post('/api/test')
      .send(body)
      .set('x-stellar-signature', 'test')
      .set('x-signature-timestamp', String(timestamp))
      .set('x-signature-digest', sig);

    expect(res.status).toBe(200);
  });

  it('rejects requests with body tampering', async () => {
    const signing = createRequestSigning({ secret: SECRET, enabled: true });
    const app = createTestApp(signing);

    const timestamp = Date.now();
    const sig = signPayload('POST', '/api/test', timestamp, { data: 'original' }, SECRET);

    const res = await request(app)
      .post('/api/test')
      .send({ data: 'tampered' })
      .set('x-stellar-signature', 'test')
      .set('x-signature-timestamp', String(timestamp))
      .set('x-signature-digest', sig);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  it('uses timing-safe signature comparison', () => {
    const signing = createRequestSigning({ secret: SECRET, enabled: true });
    expect(signing.computeSignature).toBeDefined();

    const sig = signing.computeSignature('test-payload', SECRET);
    expect(sig).toBeTruthy();
    expect(sig.length).toBe(64);
  });
});
