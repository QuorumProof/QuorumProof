import { Request, Response, NextFunction } from 'express';
import { createRateLimiter, RateLimitConfig } from './rateLimiter.js';
import { getDefaultApiKeyManager, ApiKeyManager } from '../services/apiKeyManager.js';

const API_KEY_HEADER = 'x-api-key';

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  max: 120,
  name: 'api-key',
  backoffMultiplier: 2,
  maxViolations: 5,
};

/**
 * Per-API-key rate limiting (#1297). Buckets requests by the presented key
 * rather than by IP/Stellar address, so a single caller can't burn through
 * another API key's quota and each key's callers are throttled independently
 * of the rest of the API's IP-based limiter.
 *
 * A request without an `x-api-key` header passes through untouched — this
 * middleware only governs traffic that is actually authenticating with a
 * managed key, and defers everything else to the general rate limiter.
 */
export function createApiKeyRateLimiter(config: RateLimitConfig = DEFAULT_CONFIG, manager?: ApiKeyManager) {
  const limiter = createRateLimiter(config, (req: Request) => {
    const raw = req.headers[API_KEY_HEADER];
    return typeof raw === 'string' && raw ? `apikey:${raw}` : 'apikey:unknown';
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.headers[API_KEY_HEADER];
    if (typeof raw !== 'string' || !raw) {
      next();
      return;
    }

    const keyManager = manager ?? getDefaultApiKeyManager();
    const key = keyManager.verifyKey(raw);
    if (!key) {
      res.status(401).json({ error: 'Invalid or expired API key' });
      return;
    }

    keyManager.recordUsage(key.id, req.path);
    (req as Request & { apiKey?: typeof key }).apiKey = key;

    limiter(req, res, next);
  };
}

export const apiKeyRateLimiter = createApiKeyRateLimiter();
