import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CircuitOpenError,
  RpcCircuitBreaker,
} from '../src/services/rpcCircuitBreaker.js';

describe('RpcCircuitBreaker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after the configured number of consecutive failures and rejects calls', async () => {
    const breaker = new RpcCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1_000,
    });

    await expect(breaker.execute(async () => { throw new Error('RPC unavailable'); }))
      .rejects.toThrow('RPC unavailable');
    expect(breaker.getState()).toBe('closed');

    await expect(breaker.execute(async () => { throw new Error('still unavailable'); }))
      .rejects.toThrow('still unavailable');
    expect(breaker.getState()).toBe('open');
    await expect(breaker.execute(async () => 'unexpected'))
      .rejects.toBeInstanceOf(CircuitOpenError);

    expect(breaker.getMetrics()).toMatchObject({
      totalCalls: 3,
      totalFailures: 2,
      totalTrips: 1,
      totalRejected: 1,
      lastFailureReason: 'still unavailable',
    });
  });

  it('resets the consecutive failure count after a success', async () => {
    const breaker = new RpcCircuitBreaker({ failureThreshold: 2 });

    await expect(breaker.execute(async () => { throw new Error('temporary'); })).rejects.toThrow();
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    await expect(breaker.execute(async () => { throw new Error('temporary again'); })).rejects.toThrow();

    expect(breaker.getState()).toBe('closed');
    expect(breaker.getMetrics().consecutiveFailures).toBe(1);
  });

  it('serves a fresh cached result while open and rejects after the cache expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const breaker = new RpcCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 10_000,
      cacheTtlMs: 100,
    });
    const cacheKeyParts = { method: 'simulateCall', args: ['credential-1'] };

    await breaker.execute(async () => ({ valid: true }), cacheKeyParts);
    await expect(breaker.execute(async () => { throw new Error('RPC down'); }, cacheKeyParts))
      .resolves.toEqual({ valid: true });
    expect(breaker.getMetrics().totalFallbackHits).toBe(1);

    vi.advanceTimersByTime(101);
    await expect(breaker.execute(async () => 'unexpected', cacheKeyParts))
      .rejects.toBeInstanceOf(CircuitOpenError);
    expect(breaker.getMetrics().totalRejected).toBe(1);
  });

  it('allows limited half-open trials, closes after consecutive successes, and resets backoff', async () => {
    vi.useFakeTimers();
    const breaker = new RpcCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      maxResetTimeoutMs: 400,
      halfOpenSuccessesToClose: 2,
      halfOpenMaxConcurrentTrials: 1,
    });
    await expect(breaker.execute(async () => { throw new Error('down'); })).rejects.toThrow();

    vi.advanceTimersByTime(100);
    expect(breaker.getState()).toBe('half-open');

    let releaseTrial!: (value: string) => void;
    const pendingTrial = breaker.execute(
      () => new Promise<string>((resolve) => { releaseTrial = resolve; }),
    );
    await expect(breaker.execute(async () => 'not admitted'))
      .rejects.toBeInstanceOf(CircuitOpenError);
    releaseTrial('trial success');
    await expect(pendingTrial).resolves.toBe('trial success');
    await breaker.execute(async () => 'second success');

    expect(breaker.getState()).toBe('closed');
    expect(breaker.getMetrics().currentResetTimeoutMs).toBe(100);
  });

  it('backs off after a failed half-open trial, up to the configured maximum', async () => {
    vi.useFakeTimers();
    const breaker = new RpcCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      maxResetTimeoutMs: 100,
    });
    await expect(breaker.execute(async () => { throw new Error('initial'); })).rejects.toThrow();

    vi.advanceTimersByTime(50);
    await expect(breaker.execute(async () => { throw new Error('trial'); })).rejects.toThrow('trial');
    expect(breaker.getMetrics().currentResetTimeoutMs).toBe(100);

    vi.advanceTimersByTime(100);
    await expect(breaker.execute(async () => { throw new Error('trial again'); })).rejects.toThrow('trial again');
    expect(breaker.getMetrics().currentResetTimeoutMs).toBe(100);
  });
});
