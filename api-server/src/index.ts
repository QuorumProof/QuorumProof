import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import compression from 'compression';
import zlib from 'zlib';
import slicesRouter from './routes/slices.js';
import credentialsRouter from './routes/credentials.js';
import notificationsRouter from './routes/notifications.js';
import analyticsRouter from './routes/analytics.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { createDDoSProtection } from './middleware/ddosProtection.js';
import { createWsServer } from './ws/server.js';
import { getConnectionCount, getSubscriberCount } from './ws/subscriptions.js';
import { getWsMetrics } from './ws/metrics.js';
import { broadcastEvent } from './ws/server.js';

const app = express();

const ddosProtection = createDDoSProtection();
app.use(ddosProtection);

app.use(express.json({ limit: '100kb' }));

// Brotli compression middleware for responses > 1KB
function brotliCompression(req: Request, res: Response, next: NextFunction): void {
  if (req.headers['x-no-compression'] || req.method === 'HEAD') {
    next();
    return;
  }
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (!acceptEncoding.includes('br')) {
    next();
    return;
  }
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const chunks: Buffer[] = [];
  let contentLength = 0;

  res.write = function (chunk: unknown, ...args: unknown[]) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buf);
    contentLength += buf.length;
    return true;
  } as typeof res.write;

  res.end = function (chunk?: unknown, ...args: unknown[]) {
    if (chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buf);
      contentLength += buf.length;
    }
    if (contentLength < 1024) {
      res.removeHeader('content-encoding');
      for (const c of chunks) originalWrite(c);
      originalEnd();
      return res;
    }
    res.setHeader('content-encoding', 'br');
    const compressed = zlib.brotliCompressSync(Buffer.concat(chunks), {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
    });
    res.setHeader('content-length', compressed.length);
    res.removeHeader('transfer-encoding');
    originalWrite(compressed);
    originalEnd();
    return res;
  } as typeof res.end;

  next();
}

app.use(brotliCompression);

// Standard gzip/deflate compression as fallback for clients without brotli
app.use(compression({ threshold: 1024, filter: (req, res) => {
  if (req.headers['accept-encoding'] && String(req.headers['accept-encoding']).includes('br')) return false;
  return compression.filter(req, res);
} }));

const apiRateLimiter = createRateLimiter({
  windowMs: 60000,
  max: 100,
  name: 'api',
  backoffMultiplier: 2,
  maxViolations: 5,
});

app.use('/api', apiRateLimiter);

app.use((req, _res, next) => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    service: 'quorumproof-api',
    method: req.method,
    path: req.path,
  }));
  next();
});

app.use('/api/slices', slicesRouter);
app.use('/api/credentials', credentialsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/analytics', analyticsRouter);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    ws_connections: getConnectionCount(),
    ws_subscribers: getSubscriberCount(),
  });
});

app.get('/ws/metrics', (_req, res) => {
  res.json(getWsMetrics());
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const httpServer = createServer(app);
createWsServer(httpServer, '/ws');

httpServer.listen(PORT, () => console.log(`QuorumProof API server listening on port ${PORT} (WS at /ws)`));

export { broadcastEvent };
export default app;
