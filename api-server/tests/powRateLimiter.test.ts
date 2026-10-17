import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPoWRateLimiter } from '../src/middleware/powRateLimiter.js';

function makeRequest(ip: string, body: Record<string, unknown> = {}) {
  return {
    ip,
    socket: { remoteAddress: '127.0.0.1' },
    body,
    powVerified: false,
  };
}

function makeResponse() {
  const response: {
    statusCode: number;
    body?: unknown;
    status: (code: number) => typeof response;
    json: (body: unknown) => typeof response;
  } = {
    statusCode: 200,
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(body) {
      response.body = body;
      return response;
    },
  };
  return response;
}

describe('PoW rate limiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns challenge and current difficulty information', () => {
    vi.useFakeTimers();
    const limiter = createPoWRateLimiter({
      enablePoW: true,
      powExemptDuration: 1_000,
      powEnabled: true,
    });
    const response = makeResponse();

    limiter.requestChallenge(makeRequest('192.0.2.1') as never, response as never);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      challenge: {
        nonce: expect.any(String),
        target: 2,
        timestamp: Date.now(),
        expires_at: Date.now() + 300_000,
      },
      difficulty_info: {
        current_difficulty: 2,
        estimated_work: 4,
        request_rate: 0,
      },
    });
    limiter.cleanup();
  });

  it('rejects missing and invalid solutions without granting an exemption', () => {
    vi.useFakeTimers();
    const limiter = createPoWRateLimiter({
      enablePoW: true,
      powExemptDuration: 1_000,
      powEnabled: true,
    });
    const next = vi.fn();
    const missingResponse = makeResponse();
    const invalidResponse = makeResponse();
    vi.spyOn(limiter.powManager, 'verifySolution').mockReturnValue(false);

    limiter.submitSolution(makeRequest('192.0.2.2') as never, missingResponse as never);
    limiter.submitSolution(
      makeRequest('192.0.2.2', { challenge_nonce: 'challenge', nonce_solution: 'bad' }) as never,
      invalidResponse as never,
    );
    const protectedRequest = makeRequest('192.0.2.2');
    limiter.middleware(protectedRequest as never, makeResponse() as never, next);

    expect(missingResponse.statusCode).toBe(400);
    expect(missingResponse.body).toMatchObject({ error: 'Invalid request' });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.body).toMatchObject({ error: 'Invalid solution' });
    expect(protectedRequest.powVerified).toBe(false);
    expect(next).toHaveBeenCalledOnce();
    limiter.cleanup();
  });

  it('grants a temporary IP exemption after a valid solution and expires it on time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-01T00:00:00.000Z'));
    const limiter = createPoWRateLimiter({
      enablePoW: true,
      powExemptDuration: 1_000,
      powEnabled: true,
    });
    const requestIp = '192.0.2.3';
    const response = makeResponse();
    const next = vi.fn();
    const body = { challenge_nonce: 'valid-challenge', nonce_solution: 'valid-solution' };
    vi.spyOn(limiter.powManager, 'verifySolution').mockReturnValue(true);

    limiter.submitSolution(makeRequest(requestIp, body) as never, response as never);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      exempt_until: Date.now() + 1_000,
    });

    const exemptRequest = makeRequest(requestIp);
    limiter.middleware(exemptRequest as never, makeResponse() as never, next);
    expect(exemptRequest.powVerified).toBe(true);

    vi.advanceTimersByTime(1_001);
    const expiredRequest = makeRequest(requestIp);
    limiter.middleware(expiredRequest as never, makeResponse() as never, next);
    expect(expiredRequest.powVerified).toBe(false);
    expect(next).toHaveBeenCalledTimes(2);
    limiter.cleanup();
  });

  it('does not grant exemptions when PoW enforcement is disabled', () => {
    vi.useFakeTimers();
    const limiter = createPoWRateLimiter({
      enablePoW: false,
      powExemptDuration: 1_000,
      powEnabled: false,
    });
    const next = vi.fn();
    const req = makeRequest('192.0.2.4');

    limiter.middleware(req as never, makeResponse() as never, next);

    expect(req.powVerified).toBe(false);
    expect(next).toHaveBeenCalledOnce();
    limiter.cleanup();
  });
});
