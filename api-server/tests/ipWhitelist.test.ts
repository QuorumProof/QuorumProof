import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createIPWhitelistMiddleware,
  initializeWhitelist,
  setProtectedEndpoints,
} from '../src/middleware/ipWhitelist.js';

describe('IP whitelist proxy headers', () => {
  it('does not allow a caller-supplied forwarding header to choose the whitelisted IP', async () => {
    initializeWhitelist(['203.0.113.10']);
    setProtectedEndpoints(['/api/admin/test']);

    const app = express();
    app.use(createIPWhitelistMiddleware());
    app.get('/api/admin/test', (_req, res) => res.sendStatus(200));

    const response = await request(app)
      .get('/api/admin/test')
      .set('x-forwarded-for', '203.0.113.10')
      .set('cf-connecting-ip', '203.0.113.10')
      .set('x-client-ip', '203.0.113.10')
      .set('x-real-ip', '203.0.113.10');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('IP_NOT_WHITELISTED');
  });
});
