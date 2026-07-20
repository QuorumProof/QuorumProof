import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import bridgeRouter from '../src/routes/bridge.js';
import { BridgeStore, _setDefaultBridgeStoreForTest } from '../src/services/bridgeStore.js';
import { BlockHeaderStore, _setDefaultBlockHeaderStoreForTest } from '../src/services/blockHeaderStore.js';

function loadFixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/headers', `${name}.json`), 'utf8'));
}

const app = express();
app.use(express.json());
app.use('/api/bridge', bridgeRouter);

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-route-test-'));
  _setDefaultBridgeStoreForTest(new BridgeStore(dataDir));
  _setDefaultBlockHeaderStoreForTest(new BlockHeaderStore(dataDir));
});

afterEach(() => {
  _setDefaultBridgeStoreForTest(undefined);
  _setDefaultBlockHeaderStoreForTest(undefined);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/bridge/chains', () => {
  it('lists supported chains', async () => {
    const res = await request(app).get('/api/bridge/chains');
    expect(res.status).toBe(200);
    expect(res.body.chains.find((c: { chain_id: number }) => c.chain_id === 1).name).toBe('Ethereum Mainnet');
  });
});

describe('POST /api/bridge/headers', () => {
  it('rejects without an admin role', async () => {
    const res = await request(app)
      .post('/api/bridge/headers')
      .send({ chain_id: 1, header: loadFixture('mainnet-finalized'), finality: { mode: 'tag', tag: 'finalized' } });
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin role', async () => {
    const res = await request(app)
      .post('/api/bridge/headers')
      .set('x-role', 'verifier')
      .send({ chain_id: 1, header: loadFixture('mainnet-finalized'), finality: { mode: 'tag', tag: 'finalized' } });
    expect(res.status).toBe(403);
  });

  it('checkpoints a genuine header as admin', async () => {
    const res = await request(app)
      .post('/api/bridge/headers')
      .set('x-role', 'admin')
      .send({ chain_id: 1, header: loadFixture('mainnet-finalized'), finality: { mode: 'tag', tag: 'finalized' } });
    expect(res.status).toBe(201);
    expect(res.body.blockHash).toBe(loadFixture('mainnet-finalized').hash.toLowerCase());
  });

  it('rejects a header that fails self-consistency', async () => {
    const tampered = { ...loadFixture('mainnet-finalized'), receiptsRoot: '0x' + '11'.repeat(32) };
    const res = await request(app)
      .post('/api/bridge/headers')
      .set('x-role', 'admin')
      .send({ chain_id: 1, header: tampered, finality: { mode: 'tag', tag: 'finalized' } });
    expect(res.status).toBe(422);
  });

  it('rejects insufficient confirmations', async () => {
    const header = loadFixture('mainnet-finalized');
    const res = await request(app)
      .post('/api/bridge/headers')
      .set('x-role', 'admin')
      .send({
        chain_id: 1,
        header,
        finality: { mode: 'confirmations', head_block_number: parseInt(header.number, 16) + 1 },
      });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/bridge/anchors', () => {
  it('registers a pending anchor (contract not deployed in test env, so it falls back to durable storage)', async () => {
    const res = await request(app)
      .post('/api/bridge/anchors')
      .send({
        credential_id: 1,
        chain_id: 1,
        tx_hash: '0x' + 'ab'.repeat(32),
        block_number: 100,
        block_hash: '0x' + 'cd'.repeat(32),
        block_timestamp: 1700000000,
        contract_address: '0x' + 'ef'.repeat(20),
        admin: 'GADMIN',
      });
    expect(res.status).toBe(202);
    expect(res.body.anchor.verified).toBe(false);
  });

  it('returns 400 for an unsupported chain', async () => {
    const res = await request(app)
      .post('/api/bridge/anchors')
      .send({
        credential_id: 1,
        chain_id: 4242,
        tx_hash: '0x' + 'ab'.repeat(32),
        block_number: 100,
        block_hash: '0x' + 'cd'.repeat(32),
        block_timestamp: 1700000000,
        contract_address: '0x' + 'ef'.repeat(20),
        admin: 'GADMIN',
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app).post('/api/bridge/anchors').send({ credential_id: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required fields/);
  });
});

describe('POST /api/bridge/anchors/:id/verify', () => {
  it('returns 400 when receipt_proof is missing', async () => {
    const res = await request(app).post('/api/bridge/anchors/1/verify').send({ admin: 'GADMIN', log_index: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an anchor that was never registered', async () => {
    const res = await request(app)
      .post('/api/bridge/anchors/999/verify')
      .send({
        admin: 'GADMIN',
        log_index: 0,
        receipt_proof: { claim: { txIndex: 0, txType: 0, status: 1, cumulativeGasUsed: '1', logsBloom: '0x' + '00'.repeat(256), logs: [] }, proofNodes: [] },
      });
    expect(res.status).toBe(404);
  });
});
