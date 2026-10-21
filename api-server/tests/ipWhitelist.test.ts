import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  clearAccessLog,
  createIPWhitelistMiddleware,
  getAccessLog,
  initializeWhitelist,
  setProtectedEndpoints,
  setTrustedProxies,
} from '../src/middleware/ipWhitelist.js';

function runMiddleware(
  remoteAddress: string,
  headers: Record<string, string>,
  path = '/api/admin/users'
) {
  const req = {
    path,
    socket: { remoteAddress },
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const json = vi.fn();
  const res = {
    status: vi.fn().mockReturnThis(),
    json,
  } as unknown as Response;
  const next = vi.fn();

  createIPWhitelistMiddleware()(req, res, next);
  return { res, json, next };
}

describe('IP whitelist middleware', () => {
  beforeEach(() => {
    initializeWhitelist([], ['/api/admin']);
    setTrustedProxies([]);
    clearAccessLog();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    initializeWhitelist([]);
    setTrustedProxies([]);
    clearAccessLog();
    vi.restoreAllMocks();
  });

  it('does not let an untrusted client bypass the whitelist with a forwarded header', () => {
    initializeWhitelist(['198.51.100.25']);

    const { res, json, next } = runMiddleware('203.0.113.10', {
      'x-forwarded-for': '198.51.100.25',
    });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'IP_NOT_WHITELISTED' }));
    expect(next).not.toHaveBeenCalled();
    expect(getAccessLog()[0]).toMatchObject({ clientIP: '203.0.113.10', action: 'denied' });
  });

  it('uses the rightmost untrusted address in a trusted proxy chain', () => {
    initializeWhitelist(['192.0.2.45']);
    setTrustedProxies(['10.0.0.0/24']);

    const { res, next } = runMiddleware('10.0.0.8', {
      'x-forwarded-for': '198.51.100.25, 192.0.2.45, 10.0.0.7',
    });

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(getAccessLog()[0]).toMatchObject({
      clientIP: '192.0.2.45',
      forwardedIP: '192.0.2.45',
      action: 'allowed',
    });
  });

  it('accepts alternate proxy headers only from a trusted proxy', () => {
    initializeWhitelist(['198.51.100.25']);
    setTrustedProxies(['10.0.0.8']);

    const { next } = runMiddleware('10.0.0.8', { 'cf-connecting-ip': '198.51.100.25' });

    expect(next).toHaveBeenCalledOnce();
    expect(getAccessLog()[0]).toMatchObject({ clientIP: '198.51.100.25', action: 'allowed' });
  });

  it('does not apply the whitelist to unprotected routes', () => {
    const { res, next } = runMiddleware('203.0.113.10', {}, '/api/health');

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(getAccessLog()).toHaveLength(0);
  });
});
