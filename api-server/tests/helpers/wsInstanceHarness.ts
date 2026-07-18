/**
 * Standalone WS instance harness for multi-process tests.
 *
 * Run as its own Node process (via tsx) with PORT and REDIS_URL set in the
 * environment. Exposes the real ws/server.ts stack (so cross-instance
 * delivery goes through the real pub/sub backend) plus a couple of trigger
 * routes the test driver uses to originate events "from this instance"
 * without needing the full credential-issuance pipeline.
 */
import express from 'express';
import { createServer } from 'http';
import { createWsServer, broadcastEvent, broadcastToAll } from '../../src/ws/server.js';
import { liveDashboard } from '../../src/services/liveDashboard.js';

const app = express();
app.use(express.json());

const httpServer = createServer(app);
createWsServer(httpServer, '/ws');

app.post('/trigger', (req, res) => {
  const count = broadcastEvent(req.body);
  res.json({ localRecipients: count });
});

app.post('/trigger-all', (req, res) => {
  const count = broadcastToAll(req.body);
  res.json({ localRecipients: count });
});

app.post('/trigger-dashboard', (req, res) => {
  const { kind, success } = req.body as { kind: string; success?: boolean };
  if (kind === 'issuance') liveDashboard.recordIssuance();
  else if (kind === 'attestation') liveDashboard.recordAttestation(success !== false);
  else if (kind === 'api_error') liveDashboard.recordApiError();
  res.json({ ok: true });
});

const port = parseInt(process.env.PORT ?? '0', 10);
httpServer.listen(port, () => {
  // Parent process watches stdout for this exact line to know the instance is ready.
  console.log(`HARNESS_READY ${port}`);
});
