import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

export interface RequestSigningConfig {
  secret: string;
  headerName: string;
  timestampHeader: string;
  signatureHeader: string;
  maxTimestampAgeMs: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: RequestSigningConfig = {
  secret: process.env.HMAC_SIGNING_SECRET ?? '',
  headerName: 'x-stellar-signature',
  timestampHeader: 'x-signature-timestamp',
  signatureHeader: 'x-signature-digest',
  maxTimestampAgeMs: 300_000,
  enabled: !!process.env.HMAC_SIGNING_SECRET,
};

function getConfig(overrides?: Partial<RequestSigningConfig>): RequestSigningConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function computeSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function createRequestSigning(config?: Partial<RequestSigningConfig>) {
  const opts = getConfig(config);

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (!opts.enabled) {
      next();
      return;
    }

    const timestamp = req.headers[opts.timestampHeader.toLowerCase()] as string | undefined;
    const signature = req.headers[opts.signatureHeader.toLowerCase()] as string | undefined;
    const authHeader = req.headers[opts.headerName.toLowerCase()] as string | undefined;

    if (!timestamp || !signature || !authHeader) {
      res.status(401).json({
        error: 'Missing authentication',
        message: `Required headers: ${opts.headerName}, ${opts.timestampHeader}, ${opts.signatureHeader}`,
      });
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
    const payload = `${method}\n${path}\n${timestamp}\n${body}`;

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

    next();
  };

  middleware.computeSignature = computeSignature;
  middleware.getConfig = getConfig;

  return middleware;
}
