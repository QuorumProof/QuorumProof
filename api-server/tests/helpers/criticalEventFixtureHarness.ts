/**
 * Standalone process (spawned via tsx, mirrors wsInstanceHarness.ts) that
 * exposes the real CriticalEventListener at GET /metrics/events, plus a
 * control route to feed it synthetic Soroban events, for the real-Prometheus
 * integration tests in criticalEventPrometheusIntegration.test.ts.
 *
 * Runs as its own process (rather than being imported in-process) because
 * the fixture has to be a real, independently-listening HTTP server for an
 * external `prometheus` binary to scrape — an in-memory supertest app isn't
 * reachable from outside the Node process.
 */
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { CriticalEventListener, type CriticalEventCategory } from '../../src/services/criticalEventListener.js';

const TOPIC_BY_CATEGORY: Record<CriticalEventCategory, string> = {
  revocation: 'RevokeCredential',
  dispute: 'DisputeRaised',
  upgrade: 'UpgradeValidated',
};

const listener = new CriticalEventListener({
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'critical-event-fixture-')),
  // No contractId => poll()/start() are no-ops; every event in this harness
  // is injected directly via processEvent(), same code path a real RPC
  // response would take.
  contractId: '',
});

const app = express();
app.use(express.json());

app.get('/metrics/events', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(listener.getMetricsPrometheus());
});

let nextId = 0;

app.post('/fixture/emit', async (req, res) => {
  const { category, count } = req.body as { category: CriticalEventCategory; count: number };
  const topic = TOPIC_BY_CATEGORY[category];
  if (!topic) {
    res.status(400).json({ error: `unknown category ${String(category)}` });
    return;
  }
  for (let i = 0; i < count; i++) {
    nextId++;
    await listener.processEvent({
      id: `fixture-${nextId}`,
      topic: [nativeToScVal(topic, { type: 'symbol' })],
      value: nativeToScVal(`fixture-${nextId}`, { type: 'string' }),
      ledger: 1000 + nextId,
      ledgerClosedAt: new Date().toISOString(),
      txHash: `fixture-tx-${nextId}`,
    });
  }
  res.json({ ok: true, metrics: listener.getMetrics() });
});

const port = parseInt(process.env.PORT ?? '0', 10);
app.listen(port, '127.0.0.1', function (this: import('http').Server) {
  const address = this.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  console.log(`HARNESS_READY ${boundPort}`);
});
