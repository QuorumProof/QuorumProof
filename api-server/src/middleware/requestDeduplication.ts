import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';

export interface RequestDeduplicationConfig {
  ttlMs?: number;
  enabled?: boolean;
  methods?: string[];
  maxEntries?: number;
}

interface CacheEntry {
  statusCode: number;
  headers: Record<string, string | number | string[] | undefined>;
  body: unknown;
  createdAt: number;
}

interface PendingEntry {
  waiters: Response[];
  resolve: (value: CacheEntry) => void;
  reject: (reason?: unknown) => void;
}

function normalizeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      normalized[key] = normalizeValue(item);
    }
    return normalized;
  }

  return value;
}

function serializeValue(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}

export function createRequestDeduplication(config: RequestDeduplicationConfig = {}) {
  const ttlMs = config.ttlMs ?? 100;
  const enabled = config.enabled ?? true;
  const methods = new Set((config.methods ?? ['GET', 'HEAD', 'OPTIONS']).map((method) => method.toUpperCase()));
  const maxEntries = config.maxEntries ?? 500;
  const cache = new Map<string, CacheEntry>();
  const pendingByKey = new Map<string, PendingEntry>();

  function cleanupExpired(now: number): void {
    for (const [key, entry] of cache.entries()) {
      if (now - entry.createdAt > ttlMs) {
        cache.delete(key);
      }
    }
  }

  function buildFingerprint(req: Request): string {
    const headerValues = ['x-stellar-address', 'x-correlation-id', 'x-request-id']
      .map((headerName) => {
        const value = req.headers[headerName];
        return value ? `${headerName}:${Array.isArray(value) ? value.join(',') : value}` : '';
      })
      .filter(Boolean)
      .join('|');

    const payload = `${req.method}:${req.originalUrl}:${serializeValue(req.query)}:${serializeValue(req.body)}:${headerValues}`;
    return createHash('sha256').update(payload).digest('hex');
  }

  function respondFromCache(res: Response, entry: CacheEntry): void {
    res.status(entry.statusCode);
    for (const [name, value] of Object.entries(entry.headers)) {
      if (value === undefined) continue;
      res.setHeader(name, value as string | number | string[]);
    }
    if (entry.body === undefined) {
      res.end();
      return;
    }
    res.send(entry.body);
  }

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled || !methods.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const now = Date.now();
    cleanupExpired(now);

    const fingerprint = buildFingerprint(req);
    const cached = cache.get(fingerprint);
    if (cached && now - cached.createdAt < ttlMs) {
      respondFromCache(res, cached);
      return;
    }

    const pending = pendingByKey.get(fingerprint);
    if (pending) {
      pending.waiters.push(res);
      return;
    }

    let settled = false;
    const waiters: Response[] = [];
    const pendingEntry: PendingEntry = {
      waiters,
      resolve: (value) => {
        if (settled) return;
        settled = true;
        pendingByKey.delete(fingerprint);
        cache.set(fingerprint, value);
        if (cache.size > maxEntries) {
          const firstKey = cache.keys().next().value;
          if (firstKey) {
            cache.delete(firstKey);
          }
        }
        for (const waiter of waiters) {
          respondFromCache(waiter, value);
        }
      },
      reject: () => {
        if (settled) return;
        settled = true;
        pendingByKey.delete(fingerprint);
        for (const waiter of waiters) {
          waiter.status(504).json({ error: 'Request deduplication timeout' });
        }
      },
    };
    pendingByKey.set(fingerprint, pendingEntry);

    const originalSetHeader = res.setHeader.bind(res);
    const originalStatus = res.status.bind(res);
    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);
    const originalEnd = res.end.bind(res);

    const flushResponse = () => {
      if (captured.finalized) {
        return;
      }
      finalize(captured.body);
    };

    res.once('finish', flushResponse);
    res.once('close', flushResponse);

    const captured: {
      statusCode: number;
      headers: Record<string, string | number | string[] | undefined>;
      body: unknown;
      finalized: boolean;
    } = {
      statusCode: res.statusCode,
      headers: {},
      body: undefined,
      finalized: false,
    };

    const finalize = (body: unknown): void => {
      if (captured.finalized) {
        return;
      }
      captured.finalized = true;
      captured.statusCode = res.statusCode;
      captured.headers = { ...res.getHeaders() };
      if (body !== undefined) {
        captured.body = body;
      }
      pendingEntry.resolve({
        statusCode: captured.statusCode,
        headers: captured.headers,
        body: captured.body,
        createdAt: Date.now(),
      });
    };

    res.setHeader = ((name: string, value: string | number | string[]) => {
      captured.headers[name] = value;
      return originalSetHeader(name, value);
    }) as typeof res.setHeader;

    res.status = ((code: number) => {
      captured.statusCode = code;
      return originalStatus(code);
    }) as typeof res.status;

    res.send = ((body: unknown) => {
      captured.body = body;
      return originalSend(body as never);
    }) as typeof res.send;

    res.json = ((body: unknown) => {
      captured.body = body;
      return originalJson(body as never);
    }) as typeof res.json;

    res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
      if (chunk !== undefined) {
        captured.body = chunk;
      }
      finalize(captured.body);
      if (typeof encoding === 'function') {
        return originalEnd(chunk as never, encoding as never);
      }
      if (typeof callback === 'function') {
        return originalEnd(chunk as never, encoding as never, callback as never);
      }
      return originalEnd(chunk as never, encoding as never);
    }) as typeof res.end;

    next();
  };

  middleware.reset = () => {
    cache.clear();
    pendingByKey.clear();
  };

  middleware.cache = cache;

  return middleware;
}

export default createRequestDeduplication;
