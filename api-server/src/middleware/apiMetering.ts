import { Request, Response, NextFunction } from 'express';

export interface ApiMeter {
  requests: number;
  errors: number;
  totalDurationMs: number;
  lastStatus: number;
  lastSeenAt: string;
  durationBuckets: number[];
}

const REQUEST_DURATION_BUCKETS_SECONDS = [0.1, 0.5, 1, 2, 5];
const HISTOGRAM_NAME = 'quorumproof_api_request_duration_seconds';

const meters = new Map<string, ApiMeter>();

function routeKey(req: Request): string {
  return `${req.method.toUpperCase()} ${req.route?.path ?? req.path}`;
}

export function apiMeteringMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  res.once('finish', () => {
    const key = routeKey(req);
    const existing = meters.get(key) ?? {
      requests: 0,
      errors: 0,
      totalDurationMs: 0,
      lastStatus: 0,
      lastSeenAt: new Date(0).toISOString(),
      durationBuckets: REQUEST_DURATION_BUCKETS_SECONDS.map(() => 0),
    };
    const duration = Math.max(0, Date.now() - startedAt);
    const durationSeconds = duration / 1000;
    const durationBuckets = [...existing.durationBuckets];
    for (let i = 0; i < REQUEST_DURATION_BUCKETS_SECONDS.length; i++) {
      if (durationSeconds <= REQUEST_DURATION_BUCKETS_SECONDS[i]) {
        durationBuckets[i] += 1;
      }
    }
    meters.set(key, {
      requests: existing.requests + 1,
      errors: existing.errors + (res.statusCode >= 500 ? 1 : 0),
      totalDurationMs: existing.totalDurationMs + duration,
      lastStatus: res.statusCode,
      lastSeenAt: new Date().toISOString(),
      durationBuckets,
    });
  });
  next();
}

export function getApiMeteringReport() {
  return {
    generated_at: new Date().toISOString(),
    routes: Array.from(meters.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([route, meter]) => ({
        route,
        requests: meter.requests,
        errors: meter.errors,
        avg_duration_ms: meter.requests > 0 ? Math.round(meter.totalDurationMs / meter.requests) : 0,
        last_status: meter.lastStatus,
        last_seen_at: meter.lastSeenAt,
      })),
  };
}

export function getApiMeteringPrometheus(): string {
  const lines = [
    '# HELP quorumproof_api_requests_total Total API requests by route',
    '# TYPE quorumproof_api_requests_total counter',
    '# HELP quorumproof_api_errors_total Total API 5xx responses by route',
    '# TYPE quorumproof_api_errors_total counter',
    '# HELP quorumproof_api_avg_duration_ms Average API duration by route',
    '# TYPE quorumproof_api_avg_duration_ms gauge',
    `# HELP ${HISTOGRAM_NAME} API request duration by route`,
    `# TYPE ${HISTOGRAM_NAME} histogram`,
  ];

  for (const [route, meter] of meters.entries()) {
    const label = route.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const avg = meter.requests > 0 ? Math.round(meter.totalDurationMs / meter.requests) : 0;
    lines.push(`quorumproof_api_requests_total{route="${label}"} ${meter.requests}`);
    lines.push(`quorumproof_api_errors_total{route="${label}"} ${meter.errors}`);
    lines.push(`quorumproof_api_avg_duration_ms{route="${label}"} ${avg}`);
    for (let i = 0; i < REQUEST_DURATION_BUCKETS_SECONDS.length; i++) {
      lines.push(
        `${HISTOGRAM_NAME}_bucket{route="${label}",le="${REQUEST_DURATION_BUCKETS_SECONDS[i]}"} ${meter.durationBuckets[i]}`,
      );
    }
    lines.push(`${HISTOGRAM_NAME}_bucket{route="${label}",le="+Inf"} ${meter.requests}`);
    lines.push(`${HISTOGRAM_NAME}_sum{route="${label}"} ${meter.totalDurationMs / 1000}`);
    lines.push(`${HISTOGRAM_NAME}_count{route="${label}"} ${meter.requests}`);
  }

  return `${lines.join('\n')}\n`;
}
