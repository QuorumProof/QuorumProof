/**
 * Issue #1306 — Structured Logging with Log Levels
 *
 * Provides a lightweight JSON logger for the QuorumProof API server.
 * Each log entry is a single-line JSON object written to stdout/stderr so
 * log aggregators (CloudWatch, ELK, Datadog, …) can parse it without regex.
 *
 * ## Log levels (in ascending severity)
 *   debug < info < warn < error
 *
 * ## Configuration
 *   LOG_LEVEL  — minimum level to emit (default: "info").
 *                Set to "debug" in development, "warn" in noisy environments.
 *   LOG_SERVICE — service name embedded in every log line (default: "quorumproof-api").
 *
 * ## Log entry shape
 * ```json
 * {
 *   "ts":      "2026-07-28T14:00:00.000Z",
 *   "level":   "info",
 *   "service": "quorumproof-api",
 *   "msg":     "Server started",
 *   "port":    3000
 * }
 * ```
 * Extra fields passed as the second argument are spread into the top-level
 * object, keeping entries flat and easy to index.
 *
 * ## Request logging
 * Use `requestLogger()` to get an Express middleware that emits one log line
 * per request including method, path, status, and latency.
 *
 * ## Module-scoped loggers
 * Use `createLogger(module)` to get a logger that automatically adds a
 * `module` field to every entry, enabling per-module log filtering.
 */

import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Level definitions
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function parseLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  const normalised = raw?.toLowerCase();
  if (normalised && normalised in LEVEL_RANK) return normalised as LogLevel;
  return fallback;
}

// ---------------------------------------------------------------------------
// Configuration (read once at import time; can be overridden in tests via
// setLogLevel / setLogService)
// ---------------------------------------------------------------------------

let _minLevel: LogLevel = parseLevel(process.env.LOG_LEVEL, 'info');
let _service: string = process.env.LOG_SERVICE ?? 'quorumproof-api';

/** Override the minimum log level at runtime (useful in tests). */
export function setLogLevel(level: LogLevel): void {
  _minLevel = level;
}

/** Override the service name at runtime (useful in tests). */
export function setLogService(service: string): void {
  _service = service;
}

// ---------------------------------------------------------------------------
// Core emit function
// ---------------------------------------------------------------------------

type LogFields = Record<string, unknown>;

function emit(level: LogLevel, msg: string, fields: LogFields = {}): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[_minLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    service: _service,
    msg,
    ...fields,
  };

  const line = JSON.stringify(entry);

  // error and warn → stderr; everything else → stdout.
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

// ---------------------------------------------------------------------------
// Root logger
// ---------------------------------------------------------------------------

export const logger = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info:  (msg: string, fields?: LogFields) => emit('info',  msg, fields),
  warn:  (msg: string, fields?: LogFields) => emit('warn',  msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
};

// ---------------------------------------------------------------------------
// Module-scoped child logger
// ---------------------------------------------------------------------------

/**
 * Returns a logger that automatically includes `{ module }` in every entry.
 *
 * @example
 * ```ts
 * const log = createLogger('health');
 * log.info('DB ping OK', { latencyMs: 4 });
 * // → {"ts":"…","level":"info","service":"quorumproof-api","module":"health","msg":"DB ping OK","latencyMs":4}
 * ```
 */
export function createLogger(module: string) {
  return {
    debug: (msg: string, fields?: LogFields) => emit('debug', msg, { module, ...fields }),
    info:  (msg: string, fields?: LogFields) => emit('info',  msg, { module, ...fields }),
    warn:  (msg: string, fields?: LogFields) => emit('warn',  msg, { module, ...fields }),
    error: (msg: string, fields?: LogFields) => emit('error', msg, { module, ...fields }),
  };
}

// ---------------------------------------------------------------------------
// Express request-logging middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that logs one structured line per request.
 *
 * Logged fields: method, path, status, latencyMs, contentLength, requestId.
 *
 * The `requestId` is taken from `x-request-id` if present, otherwise a short
 * random hex string is generated and attached to `res.locals.requestId` so
 * downstream handlers can correlate logs to a specific request.
 *
 * @example
 * ```ts
 * import { requestLogger } from './logger.js';
 * app.use(requestLogger());
 * ```
 */
export function requestLogger() {
  const log = createLogger('http');

  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();

    // Assign / propagate a request id.
    const requestId =
      (req.headers['x-request-id'] as string | undefined) ??
      Math.random().toString(16).slice(2, 10);
    res.locals['requestId'] = requestId;
    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      const latencyMs = Date.now() - start;
      const level: LogLevel = res.statusCode >= 500 ? 'error'
                            : res.statusCode >= 400 ? 'warn'
                            : 'info';

      log[level]('request', {
        requestId,
        method:        req.method,
        path:          req.path,
        status:        res.statusCode,
        latencyMs,
        contentLength: res.getHeader('content-length') ?? null,
      });
    });

    next();
  };
}

export default logger;
