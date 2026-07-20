import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BlockHeaderStore, HeaderVerificationError } from '../src/services/blockHeaderStore.js';

// Real, previously-fetched finalized headers (see tests/fixtures/headers/*.json) —
// these are genuine mainnet/Sepolia/Polygon blocks, so the hash-self-consistency
// check exercises the real @ethereumjs/block RLP encoding, not a hand-rolled stub.
function loadFixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/headers', `${name}.json`), 'utf8'));
}

let dataDir: string;
let store: BlockHeaderStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-headers-test-'));
  store = new BlockHeaderStore(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('BlockHeaderStore', () => {
  it('checkpoints a genuine mainnet header via tag finality', () => {
    const header = loadFixture('mainnet-finalized');
    const checkpointed = store.checkpoint({ chainId: 1, rpcHeader: header, finality: { mode: 'tag', tag: 'finalized' } });
    expect(checkpointed.blockHash).toBe(header.hash.toLowerCase());
    expect(checkpointed.receiptsRoot).toBe(header.receiptsRoot.toLowerCase());
    expect(checkpointed.finalityMode).toBe('tag');
  });

  it('checkpoints a genuine Sepolia header', () => {
    const header = loadFixture('sepolia-finalized');
    const checkpointed = store.checkpoint({ chainId: 11155111, rpcHeader: header, finality: { mode: 'tag', tag: 'finalized' } });
    expect(checkpointed.blockHash).toBe(header.hash.toLowerCase());
  });

  it('checkpoints a genuine Polygon header (non-Ethereum consensus, different header shape)', () => {
    const header = loadFixture('polygon-finalized');
    const checkpointed = store.checkpoint({ chainId: 137, rpcHeader: header, finality: { mode: 'tag', tag: 'finalized' } });
    expect(checkpointed.blockHash).toBe(header.hash.toLowerCase());
  });

  it('rejects a header whose claimed hash does not match its RLP-encoded fields', () => {
    const header = { ...loadFixture('mainnet-finalized') };
    header.receiptsRoot = '0x' + '11'.repeat(32); // tamper with a field that feeds the hash
    expect(() => store.checkpoint({ chainId: 1, rpcHeader: header, finality: { mode: 'tag', tag: 'finalized' } })).toThrow(
      HeaderVerificationError,
    );
  });

  it('accepts confirmations-mode finality when depth is sufficient', () => {
    const header = loadFixture('mainnet-finalized');
    const blockNumber = parseInt(header.number, 16);
    const checkpointed = store.checkpoint({
      chainId: 1,
      rpcHeader: header,
      finality: { mode: 'confirmations', headBlockNumber: blockNumber + 12 },
    });
    expect(checkpointed.finalityMode).toBe('confirmations');
  });

  it('rejects confirmations-mode finality when depth is insufficient', () => {
    const header = loadFixture('mainnet-finalized');
    const blockNumber = parseInt(header.number, 16);
    expect(() =>
      store.checkpoint({
        chainId: 1,
        rpcHeader: header,
        finality: { mode: 'confirmations', headBlockNumber: blockNumber + 3 },
      }),
    ).toThrow(HeaderVerificationError);
  });

  it('refuses a conflicting checkpoint at the same height with a different hash', () => {
    const header = loadFixture('mainnet-finalized');
    store.checkpoint({ chainId: 1, rpcHeader: header, finality: { mode: 'tag', tag: 'finalized' } });

    // A different, but still self-consistent, header cannot be substituted at the same height.
    const otherHeader = { ...loadFixture('sepolia-finalized') };
    otherHeader.number = header.number; // pretend it's at the same height

    expect(() =>
      store.checkpoint({ chainId: 1, rpcHeader: otherHeader, finality: { mode: 'tag', tag: 'finalized' } }),
    ).toThrow(HeaderVerificationError);
  });

  it('idempotently re-checkpoints the identical header at the same height', () => {
    const header = loadFixture('mainnet-finalized');
    store.checkpoint({ chainId: 1, rpcHeader: header, finality: { mode: 'tag', tag: 'finalized' } });
    expect(() => store.checkpoint({ chainId: 1, rpcHeader: header, finality: { mode: 'tag', tag: 'finalized' } })).not.toThrow();
  });

  it('persists checkpointed headers across a process restart (durable, not in-memory)', () => {
    const header = loadFixture('mainnet-finalized');
    store.checkpoint({ chainId: 1, rpcHeader: header, finality: { mode: 'tag', tag: 'finalized' } });

    const reopened = new BlockHeaderStore(dataDir);
    const found = reopened.getByHash(1, header.hash);
    expect(found).toBeDefined();
    expect(found?.receiptsRoot).toBe(header.receiptsRoot.toLowerCase());
  });

  it('throws for a chain with no header schema mapping', () => {
    const header = loadFixture('mainnet-finalized');
    expect(() =>
      store.checkpoint({ chainId: 999999, rpcHeader: header, finality: { mode: 'tag', tag: 'finalized' } }),
    ).toThrow();
  });
});
