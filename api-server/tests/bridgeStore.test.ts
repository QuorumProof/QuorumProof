import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BridgeStore, ProofType, type ForeignChainEvent } from '../src/services/bridgeStore.js';

let dataDir: string;
let store: BridgeStore;

function event(overrides: Partial<ForeignChainEvent> = {}): ForeignChainEvent {
  return {
    chainId: 1,
    txHash: 'abc123',
    blockNumber: 100,
    blockHash: '0x' + 'aa'.repeat(32),
    contractAddress: '0x' + 'bb'.repeat(20),
    blockTimestamp: 1700000000,
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-store-test-'));
  store = new BridgeStore(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('BridgeStore', () => {
  it('prepares an anchor and retrieves it by tx hash', () => {
    const record = store.prepare({
      credentialId: 1,
      chainId: 1,
      chainName: 'Ethereum Mainnet',
      txHash: 'abc123',
      proofHash: 'deadbeef',
      proofType: ProofType.HashOnly,
      anchoredAt: 123,
      verified: false,
      foreignEvent: event(),
    });
    expect(record.anchorId).toBeNull();
    expect(store.getByTxHash('abc123')).toEqual(record);
  });

  it('confirms an anchor, allocating it a durable anchor ID', () => {
    store.prepare({
      credentialId: 1,
      chainId: 1,
      chainName: 'Ethereum Mainnet',
      txHash: 'abc123',
      proofHash: 'deadbeef',
      proofType: ProofType.HashOnly,
      anchoredAt: 123,
      verified: false,
      foreignEvent: event(),
    });

    const confirmed = store.confirm('abc123', 5);
    expect(confirmed?.anchorId).toBe(5);
    expect(store.getById(5)?.txHash).toBe('abc123');
  });

  it('marks an anchor verified', () => {
    store.prepare({
      credentialId: 1,
      chainId: 1,
      chainName: 'Ethereum Mainnet',
      txHash: 'abc123',
      proofHash: 'deadbeef',
      proofType: ProofType.HashOnly,
      anchoredAt: 123,
      verified: false,
      foreignEvent: event(),
    });
    store.confirm('abc123', 5);
    store.markVerified(5);
    expect(store.getById(5)?.verified).toBe(true);
  });

  it('excludes confirmed anchors from getPending', () => {
    store.prepare({
      credentialId: 1,
      chainId: 1,
      chainName: 'Ethereum Mainnet',
      txHash: 'pending-tx',
      proofHash: 'x',
      proofType: ProofType.HashOnly,
      anchoredAt: 1,
      verified: false,
      foreignEvent: event({ txHash: 'pending-tx' }),
    });
    store.prepare({
      credentialId: 2,
      chainId: 1,
      chainName: 'Ethereum Mainnet',
      txHash: 'confirmed-tx',
      proofHash: 'y',
      proofType: ProofType.HashOnly,
      anchoredAt: 1,
      verified: false,
      foreignEvent: event({ txHash: 'confirmed-tx' }),
    });
    store.confirm('confirmed-tx', 1);

    const pending = store.getPending();
    expect(pending.map((p) => p.txHash)).toEqual(['pending-tx']);
  });

  it('survives a process restart — anchors and verified state are durable, not in-memory', () => {
    store.prepare({
      credentialId: 1,
      chainId: 1,
      chainName: 'Ethereum Mainnet',
      txHash: 'abc123',
      proofHash: 'deadbeef',
      proofType: ProofType.HashOnly,
      anchoredAt: 123,
      verified: false,
      foreignEvent: event(),
    });
    store.confirm('abc123', 5);
    store.markVerified(5);

    const reopened = new BridgeStore(dataDir);
    const anchor = reopened.getById(5);
    expect(anchor).toBeDefined();
    expect(anchor?.verified).toBe(true);
    expect(anchor?.txHash).toBe('abc123');
  });
});
