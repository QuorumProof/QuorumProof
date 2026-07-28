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
import oauth2Router from './routes/oauth2.js';
import healthRouter from './routes/health.js';
import privilegeEscalationRouter from './routes/privilegeEscalation.js';
import tracingRouter from './routes/tracing.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { cacheControl } from './middleware/cacheControl.js';
// #1303: CORS middleware
import { createCorsFromEnv } from './middleware/cors.js';
// #1304: Adaptive rate limiter
import { createAdaptiveRateLimiter } from './middleware/adaptiveRateLimiter.js';
import { createRequestDeduplication } from './middleware/requestDeduplication.js';
import { rbac } from './middleware/rbac.js';
import { createDDoSProtection } from './middleware/ddosProtection.js';
import { createRequestSigning } from './middleware/requestSigning.js';
import { apiKeyRateLimiter } from './middleware/apiKeyRateLimit.js';
// #1306: Structured logging
import { structuredLoggingMiddleware } from './middleware/structuredLogging.js';
// #1307: Distributed tracing
import { distributedTracingMiddleware } from './middleware/distributedTracingMiddleware.js';
import { createWsServer } from './ws/server.js';
import { getSubscriberCount } from './ws/subscriptions.js';
import { getWsMetrics, getWsMetricsPrometheus } from './ws/metrics.js';
import { getDefaultRpcCircuitBreaker } from './services/rpcCircuitBreaker.js';
import { getDefaultCriticalEventListener } from './services/criticalEventListener.js';
import { broadcastEvent, getConnectionCount } from './ws/server.js';
import * as Soroban from './soroban.js';

const app = express();

// #1303: Apply CORS before all other middleware so preflight requests are handled
// without requiring auth. Origins are configured via CORS_ALLOWED_ORIGINS env var.
const cors = createCorsFromEnv();
app.use(cors);

const ddosProtection = createDDoSProtection();
app.use(ddosProtection);

// #1306: Structured logging middleware
app.use(structuredLoggingMiddleware);

// #1307: Distributed tracing middleware
app.use(distributedTracingMiddleware);

app.use(express.json({ limit: '100kb' }));

// #1297 per-API-key rate limiting: applies whenever a caller presents
// x-api-key, independently of the general IP-based limiter below, and
// no-ops for requests that don't authenticate this way.
app.use(apiKeyRateLimiter);

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
app.use('/auth/api-keys', apiKeysRouter); // #1297 API key management + rotation (spec-mandated path)
app.use('/auth/oauth2', oauth2Router); // #1296 OAuth2 / OIDC support

// #997 Credential Holder Dashboard API
const sorobanClient = {
  simulateCall: Soroban.simulateCall,
  u64Val: Soroban.u64Val,
  u32Val: Soroban.u32Val,
  addressVal: Soroban.addressVal,
};
app.use('/api/me', createDashboardRouter(sorobanClient));

// #1308: Health check endpoints
app.use('/health', healthRouter);

// #1305: Privilege escalation prevention
app.use('/api/admin/privilege-escalation', privilegeEscalationRouter);

// #1307: Distributed tracing
app.use('/api/tracing', tracingRouter);

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

// Circuit breaker state for outbound Soroban RPC calls (issue #2). See
// api-server/src/services/rpcCircuitBreaker.ts and docs/resilience.md.
app.get('/metrics/rpc', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(getDefaultRpcCircuitBreaker().getMetricsPrometheus());
});

app.get('/rpc/circuit-breaker', (_req, res) => {
  res.json(getDefaultRpcCircuitBreaker().getMetrics());
});

// Critical contract event monitoring & alerting (issue #3). See
// api-server/src/services/criticalEventListener.ts and
// docs/critical-event-alerting.md. Polling only starts when a contract id
// is configured; harmless (and inert) otherwise, so this is safe to load
// in any environment including tests.
const criticalEventListener = getDefaultCriticalEventListener();
if (process.env.CONTRACT_QUORUM_PROOF && process.env.CRITICAL_EVENT_MONITORING !== 'disabled') {
  criticalEventListener.start();
}

app.get('/metrics/events', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(criticalEventListener.getMetricsPrometheus());
});

app.get('/events/critical/recent', (_req, res) => {
  res.json({
    metrics: criticalEventListener.getMetrics(),
    events: criticalEventListener.getRecentEvents(),
  });
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const httpServer = createServer(app);
createWsServer(httpServer, '/ws');

/**
 * Apply any pending database migrations before accepting traffic. Manual
 * migrations were error-prone (an operator forgets to run them, environments
 * drift). Skipped entirely when DATABASE_URL isn't set so this stays a no-op
 * for the file/DurableLog-backed stores the API server also supports.
 *
 * A failed migration is treated as fatal for startup — see
 * docs/database-migrations.md for the rollback procedure.
 */
async function runStartupMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) return;

  const { Pool } = await import('pg');
  const { runMigrations } = await import('./migrations/runner.js');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const applied = await runMigrations(pool);
    if (applied.length > 0) {
      console.log(`Applied ${applied.length} database migration(s): ${applied.join(', ')}`);
    }
  } finally {
    await pool.end();
  }
}

(async () => {
  try {
    await runStartupMigrations();
  } catch (err) {
    console.error('Startup migration failed, refusing to start:', err);
    process.exit(1);
    return;
  }
  httpServer.listen(PORT, () =>
    console.log(`QuorumProof API server listening on port ${PORT} (WS at /ws)`)
  );
})();

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
