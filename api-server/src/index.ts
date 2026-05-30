import express, { Request, Response, NextFunction } from 'express';
import slicesRouter from './routes/slices.js';
import credentialsRouter from './routes/credentials.js';
import notificationsRouter from './routes/notifications.js';

const app = express();
app.use(express.json());

// #586 — Structured request logging (JSON lines, readable by Promtail)
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

// #587 — Health endpoint for contract health dashboard
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`QuorumProof API server listening on port ${PORT}`));

export default app;
