import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRbac } from '../src/middleware/rbac.js';

const { requirePermission } = createRbac();

const app = express();
app.get('/admin-only', requirePermission('admin:all'), (_req, res) => res.json({ ok: true }));
app.get('/read-creds', requirePermission('credentials:read'), (_req, res) => res.json({ ok: true }));
app.get('/write-creds', requirePermission('credentials:write'), (_req, res) => res.json({ ok: true }));
app.get('/reports', requirePermission('reports:read'), (_req, res) => res.json({ ok: true }));

describe('RBAC middleware', () => {
  it('allows admin to access admin-only route', async () => {
    const res = await request(app).get('/admin-only').set('x-role', 'admin');
    expect(res.status).toBe(200);
  });

  it('denies verifier from admin-only route', async () => {
    const res = await request(app).get('/admin-only').set('x-role', 'verifier');
    expect(res.status).toBe(403);
    expect(res.body.role).toBe('verifier');
  });

  it('allows verifier to read credentials', async () => {
    const res = await request(app).get('/read-creds').set('x-role', 'verifier');
    expect(res.status).toBe(200);
  });

  it('denies verifier from writing credentials', async () => {
    const res = await request(app).get('/write-creds').set('x-role', 'verifier');
    expect(res.status).toBe(403);
  });

  it('allows issuer to write credentials', async () => {
    const res = await request(app).get('/write-creds').set('x-role', 'issuer');
    expect(res.status).toBe(200);
  });

  it('allows attestor to read credentials', async () => {
    const res = await request(app).get('/read-creds').set('x-role', 'attestor');
    expect(res.status).toBe(200);
  });

  it('returns 401 when x-role header is missing', async () => {
    const res = await request(app).get('/read-creds');
    expect(res.status).toBe(401);
  });

  it('returns 401 for unknown role', async () => {
    const res = await request(app).get('/read-creds').set('x-role', 'superuser');
    expect(res.status).toBe(401);
  });

  it('allows verifier to access reports', async () => {
    const res = await request(app).get('/reports').set('x-role', 'verifier');
    expect(res.status).toBe(200);
  });

  it('denies attestor from reports', async () => {
    const res = await request(app).get('/reports').set('x-role', 'attestor');
    expect(res.status).toBe(403);
  });
});

describe('createRbac with custom permissions', () => {
  it('supports overriding role permissions', async () => {
    const custom = createRbac({
      rolePermissions: { verifier: ['reports:read', 'credentials:write'] },
    });
    const customApp = express();
    customApp.get('/write', custom.requirePermission('credentials:write'), (_req, res) =>
      res.json({ ok: true }),
    );
    const res = await request(customApp).get('/write').set('x-role', 'verifier');
    expect(res.status).toBe(200);
  });
});
