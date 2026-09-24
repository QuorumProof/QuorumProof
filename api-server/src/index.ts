import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
// #1313: Compression is configured via the dedicated middleware module.
import { createCompressionFromEnv } from './middleware/compression.js';
import slicesRouter from './routes/slices.js';
import credentialsRouter from './routes/credentials.js';
import credentialExportRouter from './routes/credentialExport.js';
import verifyRouter from './routes/verify.js';
import notificationsRouter from './routes/notifications.js';
import analyticsRouter from './routes/analytics.js';
import issuerAnalyticsRouter from './routes/issuerAnalytics.js';
import attestorRouter from './routes/attestor.js';
import { createAttestorsRouter } from './routes/attestors.js';
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
// #1309: Auto-generated OpenAPI docs (Swagger UI / ReDoc)
import docsRouter from './routes/docs.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { cacheControl } from './middleware/cacheControl.js';
// #1303: CORS middleware
import { createCorsFromEnv } from './middleware/cors.js';
// #1304: Adaptive rate limiter
import { createAdaptiveRateLimiter } from './middleware/adaptiveRateLimiter.js';
// #1310: API versioning
import { createApiVersionMiddleware } from './middleware/apiVersion.js';
import { v1Compat } from './middleware/v1Compat.js';
import v1Router from './routes/v1/index.js';
import v2Router from './routes/v2/index.js';
import { createRequestDeduplication } from './middleware/requestDeduplication.js';
import { rbac } from './middleware/rbac.js';
import { createDDoSProtection } from './middleware/ddosProtection.js';
import { createRequestSigning } from './middleware/requestSigning.js';
import { apiKeyRateLimiter } from './middleware/apiKeyRateLimit.js';
// #1306: Structured logging
import { structuredLoggingMiddleware } from './middleware/structuredLogging.js';
// #1307: Distributed tracing
import { distributedTracingMiddleware } from './middleware/distributedTracingMiddleware.js';
// #1566: Concurrent request handling limits
import { createConcurrencyLimiter } from './middleware/concurrencyLimiter.js';
import { createWsServer } from './ws/server.js';
import { getSubscriberCount } from './ws/subscriptions.js';
import { getWsMetrics, getWsMetricsPrometheus } from './ws/metrics.js';
import { getDefaultRpcCircuitBreaker } from './services/rpcCircuitBreaker.js';
import { getDefaultCriticalEventListener } from './services/criticalEventListener.js';
import { broadcastEvent as _wsServerBroadcastEvent, getConnectionCount, closeWsServer } from './ws/server.js';
import { dispatchWebhookEvent } from './services/webhooks.js';
import { createGracefulShutdown } from './services/gracefulShutdown.js';
import * as Soroban from './soroban.js';

const app = express();

// #1311: Create the HTTP server early so the graceful shutdown service can
// reference it before httpServer.listen() is called.
const httpServer = createServer(app);

// #1311: Graceful shutdown — drains in-flight requests before exiting.
// The drain timeout defaults to 30 s and is overridable via env var so
// operators can tune it without a code change.
const DRAIN_TIMEOUT_MS = parseInt(process.env.DRAIN_TIMEOUT_MS ?? '30000', 10);
const gracefulShutdown = createGracefulShutdown(httpServer, { drainTimeoutMs: DRAIN_TIMEOUT_MS });

// #1303: Apply CORS before all other middleware so preflight requests are handled
// without requiring auth. Origins are configured via CORS_ALLOWED_ORIGINS env var.
const cors = createCorsFromEnv();
app.use(cors);

// #1313: Apply gzip compression early so all subsequent responses are eligible.
// Only responses >= 1 KB threshold are compressed. Configure via env vars:
//   COMPRESSION_ENABLED, COMPRESSION_LEVEL, COMPRESSION_THRESHOLD.
app.use(createCompressionFromEnv());

const ddosProtection = createDDoSProtection();
app.use(ddosProtection);

// #1306: Structured logging middleware
app.use(structuredLoggingMiddleware);

// #1307: Distributed tracing middleware
app.use(distributedTracingMiddleware);

app.use(express.json({ limit: '100kb' }));

// #1311: Track in-flight HTTP requests. Must come after body parsers so
// the counter includes the full request lifetime, and early enough that
// every /api route is covered.
app.use(gracefulShutdown.requestCountMiddleware());

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

// #1566: Concurrent request handling limits. Caps in-flight requests with a
// semaphore, queues excess requests (graceful degradation) up to a bounded
// depth, and applies tighter per-endpoint limits for expensive routes.
const concurrencyLimiter = createConcurrencyLimiter({
  name: 'api',
  maxConcurrent: parseInt(process.env.CONCURRENCY_MAX ?? '100', 10),
  maxQueue: parseInt(process.env.CONCURRENCY_MAX_QUEUE ?? '200', 10),
  maxWaitMs: parseInt(process.env.CONCURRENCY_MAX_WAIT_MS ?? '5000', 10),
  pathOverrides: {
    '/api/verify': parseInt(process.env.CONCURRENCY_VERIFY_MAX ?? '20', 10),
    '/api/credentials': parseInt(process.env.CONCURRENCY_CREDENTIALS_MAX ?? '50', 10),
  },
});
app.use('/api', concurrencyLimiter.middleware);

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
app.use('/api/attestors', createAttestorsRouter()); // #875 attestor availability status
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

// #1566: Expose concurrency queue metrics for observability.
app.get('/health/concurrency', (_req: Request, res: Response) => {
  res.json({ limiters: concurrencyLimiter.metrics() });
});

// #1309: Auto-generated OpenAPI 3.1 docs — JSON spec, Swagger UI, ReDoc.
app.use('/api-docs', docsRouter);

// #1305: Privilege escalation prevention
app.use('/api/admin/privilege-escalation', privilegeEscalationRouter);

// #1307: Distributed 

/* … truncated 5498 chars — edit only what you need near the top … */
