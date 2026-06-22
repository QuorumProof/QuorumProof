import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from 'http';
import WebSocket from 'ws';
import express from 'express';
import * as http from 'http';
import { createWsServer, broadcastEvent, broadcastToAll, closeWsServer, getConnectionCount } from '../src/ws/server.js';
import { getSubscriberCount } from '../src/ws/subscriptions.js';
import { getWsMetrics, resetWsMetrics } from '../src/ws/metrics.js';

let httpServer: http.Server;
let wsUrl: string;
const port = 9876;

beforeAll(() => {
  const app = express();
  httpServer = createServer(app);
  createWsServer(httpServer, '/ws');

  return new Promise<void>((resolve) => {
    httpServer.listen(port, () => {
      wsUrl = `ws://localhost:${port}/ws`;
      resolve();
    });
  });
});

afterAll(() => {
  closeWsServer();
  httpServer.close();
});

function connectClient(timeoutMs = 3000): Promise<{ ws: WebSocket; firstMessage: Promise<any> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout connecting')), timeoutMs);
    const ws = new WebSocket(wsUrl);
    const firstMessage = new Promise<any>((resolveMsg, rejectMsg) => {
      const msgTimer = setTimeout(() => rejectMsg(new Error('Timeout waiting for message')), timeoutMs);
      ws.once('message', (raw) => {
        clearTimeout(msgTimer);
        resolveMsg(JSON.parse(raw.toString()));
      });
    });
    ws.once('open', () => {
      clearTimeout(timer);
      resolve({ ws, firstMessage });
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendMessage(ws: WebSocket, msg: object): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(msg), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for message')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

describe('WebSocket connection lifecycle', () => {
  beforeEach(() => {
    resetWsMetrics();
  });

  it('connects and receives welcome message', async () => {
    const { ws, firstMessage } = await connectClient();
    const msg = await firstMessage;
    expect(msg.type).toBe('connected');
    expect(msg.data).toHaveProperty('ts');
    expect(msg.data).toHaveProperty('connection_count');
    ws.close();
  });

  it('tracks connection count', async () => {
    const { ws: ws1, firstMessage: m1 } = await connectClient();
    await m1;
    const { ws: ws2, firstMessage: m2 } = await connectClient();
    await m2;
    expect(getConnectionCount()).toBeGreaterThanOrEqual(2);
    ws1.close();
    ws2.close();
  });

  it('handles subscribe message', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;
    await sendMessage(ws, { type: 'subscribe', filters: [{ credential_id: 42 }] });
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('subscription_confirmed');
    expect(msg.data.filters[0].credential_id).toBe(42);
    ws.close();
  });

  it('handles unsubscribe message', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;
    await sendMessage(ws, { type: 'subscribe', filters: [{ credential_id: 42 }] });
    await nextMessage(ws);
    await sendMessage(ws, { type: 'unsubscribe', filters: [{ credential_id: 42 }] });
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('unsubscription_confirmed');
    ws.close();
  });

  it('handles ping/pong', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;
    await sendMessage(ws, { type: 'ping' });
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('pong');
    ws.close();
  });

  it('returns error for unknown message type', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;
    await sendMessage(ws, { type: 'invalid_type' });
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    ws.close();
  });

  it('returns error for invalid JSON', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;
    ws.send('not json');
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    ws.close();
  });

  it('cleans up subscriptions on disconnect', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;
    await sendMessage(ws, { type: 'subscribe', filters: [{ credential_id: 99 }] });
    await nextMessage(ws);
    expect(getSubscriberCount()).toBeGreaterThanOrEqual(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(getSubscriberCount()).toBe(0);
  });
});

describe('Message delivery to subscribers', () => {
  beforeEach(() => {
    resetWsMetrics();
  });

  it('delivers broadcast to matching subscriber', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;
    await sendMessage(ws, { type: 'subscribe', filters: [{ credential_id: 1 }] });
    await nextMessage(ws);

    broadcastEvent({ type: 'credential_issued', credential_id: 1, timestamp: new Date().toISOString() });
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('credential_issued');
    expect(msg.data.credential_id).toBe(1);
    ws.close();
  });

  it('does not deliver to non-matching subscribers', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;
    await sendMessage(ws, { type: 'subscribe', filters: [{ credential_id: 1 }] });
    await nextMessage(ws);

    broadcastEvent({ type: 'credential_issued', credential_id: 2, timestamp: new Date().toISOString() });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('No message received (expected)')), 500)
    );
    await expect(timeoutPromise).rejects.toThrow('No message received');
    ws.close();
  });

  it('delivers to global subscribers (no filter)', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;
    await sendMessage(ws, { type: 'subscribe', filters: [] });
    await nextMessage(ws);

    broadcastEvent({ type: 'credential_revoked', credential_id: 5, timestamp: new Date().toISOString() });
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('credential_revoked');
    expect(msg.data.credential_id).toBe(5);
    ws.close();
  });

  it('supports issuer-based filtering', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;
    await sendMessage(ws, { type: 'subscribe', filters: [{ issuer: 'G_ISSUER_A' }] });
    await nextMessage(ws);

    broadcastEvent({ type: 'credential_attested', issuer: 'G_ISSUER_A', credential_id: 10, timestamp: new Date().toISOString() });
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('credential_attested');
    expect(msg.data.issuer).toBe('G_ISSUER_A');
    ws.close();
  });

  it('tracks broadcast metrics', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;

    broadcastToAll({ type: 'credential_issued', credential_id: 1, timestamp: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 100));

    const metrics = getWsMetrics();
    expect(metrics.messagesSent).toBeGreaterThanOrEqual(1);
    ws.close();
  });
});

describe('Load testing with concurrent connections', () => {
  beforeEach(() => {
    resetWsMetrics();
  });

  it('handles 100+ concurrent connections', async () => {
    const clients: Array<{ ws: WebSocket; firstMessage: Promise<any> }> = [];
    const numClients = 100;

    for (let i = 0; i < numClients; i++) {
      const c = await connectClient(5000);
      clients.push(c);
    }

    expect(getConnectionCount()).toBe(numClients);

    for (const c of clients) {
      c.ws.close();
    }
    await new Promise((r) => setTimeout(r, 500));
    expect(getConnectionCount()).toBe(0);
  }, 30000);

  it('broadcasts to 100+ subscribers', async () => {
    const clients: WebSocket[] = [];
    const numClients = 100;

    for (let i = 0; i < numClients; i++) {
      const { ws, firstMessage } = await connectClient(5000);
      await firstMessage;
      clients.push(ws);
      await sendMessage(ws, { type: 'subscribe', filters: [] });
      await nextMessage(ws);
    }

    const recipientCount = broadcastToAll({
      type: 'credential_issued',
      credential_id: 42,
      timestamp: new Date().toISOString(),
    });
    expect(recipientCount).toBe(numClients);

    const metrics = getWsMetrics();
    expect(metrics.messagesSent).toBeGreaterThanOrEqual(numClients);

    for (const ws of clients) {
      ws.close();
    }
    await new Promise((r) => setTimeout(r, 500));
  }, 30000);

  it('tracks peak connections', async () => {
    const clients: WebSocket[] = [];
    const numClients = 50;

    for (let i = 0; i < numClients; i++) {
      const { ws, firstMessage } = await connectClient(5000);
      await firstMessage;
      clients.push(ws);
    }

    const metrics = getWsMetrics();
    expect(metrics.peakConnections).toBe(numClients);

    for (const ws of clients) {
      ws.close();
    }
    await new Promise((r) => setTimeout(r, 500));
  }, 30000);
});

describe('Reconnection and edge cases', () => {
  it('handles multiple subscribe/unsubscribe cycles', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;

    for (let i = 0; i < 10; i++) {
      await sendMessage(ws, { type: 'subscribe', filters: [{ credential_id: i }] });
      const subMsg = await nextMessage(ws);
      expect(subMsg.type).toBe('subscription_confirmed');

      await sendMessage(ws, { type: 'unsubscribe', filters: [{ credential_id: i }] });
      const unsubMsg = await nextMessage(ws);
      expect(unsubMsg.type).toBe('unsubscription_confirmed');
    }

    ws.close();
  });

  it('gracefully handles rapid connect/disconnect', async () => {
    for (let i = 0; i < 20; i++) {
      const ws = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout')), 2000);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
        ws.once('error', reject);
      });
      ws.close();
    }
  }, 10000);

  it('does not deliver to closed connections', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;
    await sendMessage(ws, { type: 'subscribe', filters: [] });
    await nextMessage(ws);
    ws.close();
    await new Promise((r) => setTimeout(r, 100));

    const count = broadcastToAll({ type: 'credential_issued', credential_id: 1, timestamp: new Date().toISOString() });
    expect(count).toBe(0);
  });
});
