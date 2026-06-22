import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import slicesRouter from './routes/slices.js';
import credentialsRouter from './routes/credentials.js';
import notificationsRouter from './routes/notifications.js';
import analyticsRouter from './routes/analytics.js';

const app = express();
app.use(express.json());

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
