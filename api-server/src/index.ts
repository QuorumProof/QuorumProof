import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import compression from 'compression';
import zlib from 'zlib';
import slicesRouter from './routes/slices.js';
import credentialsRouter from './routes/credentials.js';
import credentialExportRouter from './routes/credentialExport.js';
import verifyRouter from './routes/verify.js';
import notificationsRouter from './routes/notifications.js';
import analyticsRouter from './routes/analytics.js';
import issuerAnalyticsRouter from './routes/issuerAnalytics.js';
import attestorRouter from './routes/attestor.js';
import issuerRouter from './routes/issuer.js';
import recoveryRouter from './routes/recovery.js';
import shareLinksRouter from './routes/shareLinks.js';
import consentRouter from './routes/consent.js';
import webhooksRouter from './routes/webhooks.js';
import gdprRouter from './routes/gdpr.js';
import apiKeysRouter from './routes/apiKeys.js';
// #1301: Auth audit event routes
import authAuditRouter from './routes/authAudit.js';
// #1302: Passwordless authentication routes
import passwordlessAuthRouter from './routes/passwordlessAuth.js';
import { cacheControl } from './middleware/cacheControl.js';
// #1303: CORS middleware
import { createCorsFromEnv } from './middleware/cors.js';
// #1304: Adaptive rate limiter
import { createAdaptiveRateLimiter } from './middleware/adaptiveRateLimiter.js';
import { createRequestDeduplication } from './middleware/requestDeduplication.js';
import { rbac } from './middleware/rbac.js';
import { createDDoSProtection } from './middleware/ddosProtection.js';
import { createRequestSigning } from './middleware/requestSigning.js';
import { createWsServer } from './ws/server.js';
import { getSubscriberCount } from './ws/subscriptions.js';
import { getWsMetrics, getWsMetricsPrometheus } from './ws/metrics.js';
import { broadcastEvent, getConnectionCount } from './ws/server.js';

const app = express();

// #1303: Apply CORS before all other middleware so preflight requests are handled
// without requiring auth. Origins are configured via CORS_ALLOWED_ORIGINS env var.
const cors = createCorsFromEnv();
app.use(cors);

const ddosProtection = createDDoSProtection();
app.use(ddosProtection);

app.use(express.json({ limit: '100kb' }));

const requestSigning = createRequestSigning();
const requestDeduplication = createRequestDeduplication({ ttlMs: 100, enabled: true });
app.use('/api', requestDeduplication);
app.use('/api', requestSigning);

const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? '100', 10);
const RATE_LIMIT_BACKOFF = parseInt(process.env.RATE_LIMIT_BACKOFF ?? '2', 10);
const RATE_LIMIT_MAX_VIOLATIONS = parseInt(process.env.RATE_LIMIT_MAX_VIOLATIONS ?? '5', 10);

// #1304: Use adaptive rate limiter with anomaly detection.
// Falls back gracefully — the base createRateLimiter is kept for
// targeted use cases; the adaptive one covers the /api/* prefix.
const apiRateLimiter = createAdaptiveRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  name: 'api',
  backoffMultiplier: RATE_LIMIT_BACKOFF,
  maxViolations: RATE_LIMIT_MAX_VIOLATIONS,
  anomalyThreshold: parseFloat(process.env.RATE_LIMIT_ANOMALY_THRESHOLD ?? '3'),
  blacklistDurationMs: parseInt(process.env.RATE_LIMIT_BLACKLIST_MS ?? String(60 * 60 * 1000), 10),
  // Auth endpoints get a tighter limit to limit brute-force.
  pathOverrides: {
    '/auth': parseInt(process.env.RATE_LIMIT_AUTH_MAX ?? '20', 10),
  },
});

app.use('/api', apiRateLimiter);
app.use(cacheControl);

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
app.use('/api/credentials', credentialExportRouter); // #1000 credential export (json/pdf/qrcode)
app.use('/api/verify', verifyRouter);
app.use('/api/credentials', shareLinksRouter); // #877 share links
app.use('/api/credentials', consentRouter); // #881 consent management
app.use('/api/notifications', notificationsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/analytics', issuerAnalyticsRouter); // #1001 issuer analytics (credentials/verifications/disputes)
app.use('/api/attestor', attestorRouter);
app.use('/api/issuer', issuerRouter);
app.use('/api/recovery', recoveryRouter);
app.use('/api/webhooks', webhooksRouter); // #926 event webhooks
app.use('/api/gdpr', gdprRouter);
app.use('/api/api-keys', apiKeysRouter); // #999 API key management
// #1301: Auth audit events (admin-only)
app.use('/api/audit/auth-events', authAuditRouter);
// #1302: Passwordless authentication (magic links + WebAuthn)
app.use('/api/auth/passwordless', passwordlessAuthRouter);
app.use('/api/auth/webauthn', passwordlessAuthRouter);

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

// Prometheus exposition, tagged with this instance's id — scrape every
// replica and aggregate (e.g. sum(quorumproof_ws_connections)) to get
// cluster-wide totals. See docs/websocket-scaling.md.
app.get('/metrics/ws', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(getWsMetricsPrometheus());
});

// #1304: Throttling effectiveness metrics
app.get('/metrics/throttling', (_req, res) => {
  res.json(apiRateLimiter.getMetrics());
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const httpServer = createServer(app);
createWsServer(httpServer, '/ws');

httpServer.listen(PORT, () => console.log(`QuorumProof API server listening on port ${PORT} (WS at /ws)`));

export { broadcastEvent };

// #926: fire webhooks for credential events alongside WS broadcast
// TODO: Implement webhook dispatch when dispatchWebhookEvent is available
/*
const _origBroadcast = broadcastEvent;
function broadcastEventWithWebhooks(...args: Parameters<typeof _origBroadcast>) {
  const result = _origBroadcast(...args);
  const [event] = args;
  const webhookEvents = ['credential_issued', 'credential_attested', 'credential_revoked'] as const;
  if (webhookEvents.includes(event.type as typeof webhookEvents[number])) {
    dispatchWebhookEvent({
      event: event.type,
      credential_id: event.credential_id,
      issuer: event.issuer,
      holder: event.holder,
      attestor: event.attestor,
      timestamp: event.timestamp ?? new Date().toISOString(),
    });
  }
  return result;
}
*/

export { broadcastEventWithWebhooks as broadcastEventAndWebhooks };
export default app;
