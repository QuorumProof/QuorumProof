import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

export interface RequestSigningConfig {
  secret: string;
  headerName: string;
  timestampHeader: string;
  signatureHeader: string;
  nonceHeader: string;
  maxTimestampAgeMs: number;
  maxReplayEntries: number;
  enabled: boolean;
}

function getConfig(overrides?: Partial<RequestSigningConfig>): RequestSigningConfig {
  const secret = process.env.HMAC_SIGNING_SECRET ?? '';
  return {
    secret,
    headerName: 'x-stellar-signature',
    timestampHeader: 'x-signature-timestamp',
    signatureHeader: 'x-signature-digest',
    nonceHeader: 'x-signature-nonce',
    maxTimestampAgeMs: 300_000,
    maxReplayEntries: 100_000,
    enabled: secret.trim().length > 0,
    ...overrides,
  };
}

function computeSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function createRequestSigning(config?: Partial<RequestSigningConfig>) {
  const opts = getConfig(config);
  if (process.env.NODE_ENV === 'production' && (!opts.enabled || !opts.secret.trim())) {
    throw new Error('HMAC_SIGNING_SECRET must be set and request signing enabled in production');
  }
  if (!Number.isSafeInteger(opts.maxReplayEntries) || opts.maxReplayEntries < 1) {
    throw new Error('maxReplayEntries must be a positive safe integer');
  }
  const seenNonces = new Map<string, number>();

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (!opts.enabled) {
      next();
      return;
    }

    const timestamp = req.headers[opts.timestampHeader.toLowerCase()] as string | undefined;
    const signature = req.headers[opts.signatureHeader.toLowerCase()] as string | undefined;
    const authHeader = req.headers[opts.headerName.toLowerCase()] as string | undefined;
    const nonce = req.headers[opts.nonceHeader.toLowerCase()] as string | undefined;

    if (!timestamp || !signature || !authHeader || !nonce) {
      res.status(401).json({
        error: 'Missing authentication',
        message: `Required headers: ${opts.headerName}, ${opts.timestampHeader}, ${opts.signatureHeader}, ${opts.nonceHeader}`,
      });
      return;
    }

    if (nonce.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(nonce)) {
      res.status(401).json({ error: 'Invalid nonce', message: 'Nonce must be 1-128 URL-safe characters' });
      return;
    }

    const ts = parseInt(timestamp, 10);
    if (isNaN(ts)) {
      res.status(401).json({ error: 'Invalid timestamp', message: 'Timestamp must be a Unix epoch integer' });
      return;
    }

    const now = Date.now();
    if (now - ts > opts.maxTimestampAgeMs) {
      res.status(401).json({ error: 'Expired timestamp', message: `Timestamp ${ts} is too old (max age: ${opts.maxTimestampAgeMs / 1000}s)` });
      return;
    }

    if (ts > now + 15_000) {
      res.status(401).json({ error: 'Future timestamp', message: 'Timestamp cannot be in the future' });
      return;
    }

    const method = req.method;
    const path = req.originalUrl || req.url;
    const body = JSON.stringify(req.body || {});
    const payload = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}`;

    const expectedSig = computeSignature(payload, opts.secret);

    try {
      const sigBuf = Buffer.from(signature, 'hex');
      const expectedBuf = Buffer.from(expectedSig, 'hex');

      if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
        res.status(401).json({ error: 'Invalid signature', message: 'Signature verification failed' });
        return;
      }
    } catch {
      res.status(401).json({ error: 'Invalid signature', message: 'Signature format invalid' });
      return;
    }

    const existingExpiry = seenNonces.get(nonce);
    if (existingExpiry !== undefined && existingExpiry > now) {
      res.status(401).json({ error: 'Replayed request', message: 'This request nonce has already been used' });
      return;
    }
    if (existingExpiry !== undefined) {
      seenNonces.delete(nonce);
    }
    if (seenNonces.size >= opts.maxReplayEntries) {
      for (const [cachedNonce, expiresAt] of seenNonces) {
        if (expiresAt <= now) {
          seenNonces.delete(cachedNonce);
        }
      }
      if (seenNonces.size >= opts.maxReplayEntries) {
        res.status(503).json({ error: 'Replay protection unavailable', message: 'Retry the request later' });
        return;
      }
    }
    seenNonces.set(nonce, ts + opts.maxTimestampAgeMs);

    next();
  };

  middleware.computeSignature = computeSignature;
  middleware.getConfig = getConfig;

  return middleware;
}
