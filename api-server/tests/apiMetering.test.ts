import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiMeteringMiddleware,
  getApiMeteringPrometheus,
  getApiMeteringReport,
} from '../src/middleware/apiMetering.js';

function recordRequest(
  route: string,
  statusCode: number,
  durationMs: number,
  path = route,
): void {
  const req = {
    method: 'get',
    path,
    route: { path: route },
  };
  const res = Object.assign(new EventEmitter(), { statusCode });
  const next = vi.fn();

  apiMeteringMiddleware(req as never, res as never, next);
  expect(next).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(durationMs);
  res.emit('finish');
}

describe('API metering middleware', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records request counts, 5xx errors, average duration, and the latest response', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const route = '/metering-coverage-aggregate';

    recordRequest(route, 503, 10);
    recordRequest(route, 200, 20);

    const meter = getApiMeteringReport().routes.find((entry) => entry.route === `GET ${route}`);
    expect(meter).toMatchObject({
      requests: 2,
      errors: 1,
      avg_duration_ms: 15,
      last_status: 200,
      last_seen_at: '2025-01-01T00:00:00.030Z',
    });
  });

  it('uses the route template where available and exports matching Prometheus metrics', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-01T00:00:00.000Z'));
    recordRequest('/metering-coverage-template/:id', 404, 3, '/metering-coverage-template/42');

    const route = 'GET /metering-coverage-template/:id';
    expect(getApiMeteringReport().routes.find((entry) => entry.route === route))
      .toMatchObject({ requests: 1, errors: 0, last_status: 404 });
    expect(getApiMeteringPrometheus()).toContain(
      `quorumproof_api_requests_total{route="${route}"} 1`,
    );
    expect(getApiMeteringPrometheus()).toContain(
      `quorumproof_api_errors_total{route="${route}"} 0`,
    );
  });
});
