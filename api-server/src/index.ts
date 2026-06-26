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
import { createRequestSigning } from './middleware/requestSigning.js';
import { createWsServer } from './ws/server.js';
import { getConnectionCount, getSubscriberCount } from './ws/subscriptions.js';
import { getWsMetrics } from './ws/metrics.js';
import { broadcastEvent } from './ws/server.js';

const app = express();

const ddosProtection = createDDoSProtection();
app.use(ddosProtection);

app.use(express.json({ limit: '100kb' }));

const requestSigning = createRequestSigning();
app.use('/api', requestSigning);

const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? '100', 10);
const RATE_LIMIT_BACKOFF = parseInt(process.env.RATE_LIMIT_BACKOFF ?? '2', 10);
const RATE_LIMIT_MAX_VIOLATIONS = parseInt(process.env.RATE_LIMIT_MAX_VIOLATIONS ?? '5', 10);

const apiRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  name: 'api',
  backoffMultiplier: RATE_LIMIT_BACKOFF,
  maxViolations: RATE_LIMIT_MAX_VIOLATIONS,
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
