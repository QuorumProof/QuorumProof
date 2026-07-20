import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHmac } from 'crypto';
import { BridgeStore, ProofType, type ForeignChainEvent } from '../src/services/bridgeStore.js';
import { BlockHeaderStore } from '../src/services/blockHeaderStore.js';
import {
  prepareAnchor,
  confirmAnchor,
  verifyAnchorReceiptProof,
  computeProofHash,
  AnchorVerificationError,
  getAnchorById,
} from '../src/services/crossChainBridge.js';
import { ReceiptProofError } from '../src/services/mptProof.js';

function loadFixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/headers', `${name}.json`), 'utf8'));
}

/**
 * Reproduces the *old* proof-commitment scheme this module used before
 * Issue #880 hardening: `HMAC-SHA256(BRIDGE_HMAC_SECRET, "chainId:txHash:eventData")`,
 * falling back to the hardcoded default secret `'quorumproof-bridge'` when the
 * env var isn't set (which it typically wasn't in most deployments — the
 * exact "reduces to trusting whoever holds that one secret" problem this
 * hardening pass closes).
 */
function forgeOldHmacProofHash(chainId: number, txHash: string, eventData: string, secret = 'quorumproof-bridge'): Buffer {
  return createHmac('sha256', secret).update(`${chainId}:${txHash}:${eventData}`).digest();
}

let bridgeDataDir: string;
let bridgeStore: BridgeStore;
let headerStore: BlockHeaderStore;

beforeEach(() => {
  bridgeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosschain-test-'));
  bridgeStore = new BridgeStore(bridgeDataDir);
  headerStore = new BlockHeaderStore(bridgeDataDir);
});

afterEach(() => {
  fs.rmSync(bridgeDataDir, { recursive: true, force: true });
});

describe('cross-chain bridge — HMAC trust removal', () => {
  it('a forged event "valid" under the old shared-secret HMAC scheme is rejected: knowing the secret does not verify an anchor', async () => {
    // Attacker fabricates a CredentialIssued event for a chain event that never happened,
    // and — knowing (or having leaked/guessed) the default BRIDGE_HMAC_SECRET — computes
    // exactly the commitment the *old* computeProofHash() would have accepted.
    const fabricatedEventData = '0x' + 'ff'.repeat(96);
    const forgedTxHash = 'deadbeef'.repeat(8);
    const oldStyleForgedProof = forgeOldHmacProofHash(1, forgedTxHash, fabricatedEventData);
    expect(oldStyleForgedProof).toHaveLength(32); // it's a well-formed, "valid" HMAC digest

    const foreignEvent: ForeignChainEvent = {
      chainId: 1,
      txHash: forgedTxHash,
      blockNumber: 999999,
      blockHash: '0x' + 'cc'.repeat(32), // never checkpointed — no real header backs this
      contractAddress: '0x' + 'dd'.repeat(20),
      blockTimestamp: 1700000000,
    };

    // The new commitment scheme doesn't even take the attacker's forged inputs —
    // there's no `eventData`/secret parameter to game anymore.
    const newProofHash = computeProofHash(foreignEvent);
    expect(newProofHash.toString('hex')).not.toBe(oldStyleForgedProof.toString('hex'));

    const anchor = prepareAnchor({ credentialId: 555, foreignEvent, proofType: ProofType.HashOnly }, bridgeStore);
    confirmAnchor(anchor.txHash, 4242, bridgeStore);
    expect(getAnchorById(4242, bridgeStore)?.verified).toBe(false);

    // The attacker's only "proof" is the old-style HMAC value — there is no code path
    // that accepts it. Attempting verification without a real receipt proof at all:
    await expect(
      verifyAnchorReceiptProof(
        {
          anchorId: 4242,
          logIndexInReceipt: 0,
          receiptProof: {
            claim: {
              txIndex: 0,
              txType: 0,
              status: 1,
              cumulativeGasUsed: '21000',
              logsBloom: '0x' + '00'.repeat(256),
              logs: [
                {
                  address: foreignEvent.contractAddress,
                  topics: ['0x' + '11'.repeat(32)],
                  data: fabricatedEventData,
                },
              ],
            },
            // No genuine trie nodes — the attacker has nothing that actually
            // descends from a real, checkpointed receiptsRoot.
            proofNodes: [],
          },
        },
        bridgeStore,
        headerStore,
      ),
    ).rejects.toThrow(AnchorVerificationError); // rejected at "no checkpointed header" — before proof bytes even matter

    expect(getAnchorById(4242, bridgeStore)?.verified).toBe(false);
  });

  it('rejects verification even with a syntactically valid-looking receipt proof once a real header is checkpointed, if the proof does not actually descend from its receiptsRoot', async () => {
    const header = loadFixture('mainnet-finalized');
    headerStore.checkpoint({ chainId: 1, rpcHeader: header, finality: { mode: 'tag', tag: 'finalized' } });

    const foreignEvent: ForeignChainEvent = {
      chainId: 1,
      txHash: 'abc123',
      blockNumber: parseInt(header.number, 16),
      blockHash: header.hash,
      contractAddress: '0x' + 'dd'.repeat(20),
      blockTimestamp: 1700000000,
    };
    const anchor = prepareAnchor({ credentialId: 1, foreignEvent }, bridgeStore);
    confirmAnchor(anchor.txHash, 7, bridgeStore);

    await expect(
      verifyAnchorReceiptProof(
        {
          anchorId: 7,
          logIndexInReceipt: 0,
          receiptProof: {
            claim: {
              txIndex: 0,
              txType: 0,
              status: 1,
              cumulativeGasUsed: '21000',
              logsBloom: '0x' + '00'.repeat(256),
              logs: [{ address: foreignEvent.contractAddress, topics: ['0x' + '11'.repeat(32)], data: '0x' }],
            },
            proofNodes: ['0x1234'], // garbage node, does not descend from the real receiptsRoot
          },
        },
        bridgeStore,
        headerStore,
      ),
    ).rejects.toThrow(ReceiptProofError);

    expect(getAnchorById(7, bridgeStore)?.verified).toBe(false);
  });

  it('requires a checkpointed header before any anchor for that (chainId, blockHash) can be verified', async () => {
    const foreignEvent: ForeignChainEvent = {
      chainId: 1,
      txHash: 'no-checkpoint-tx',
      blockNumber: 123,
      blockHash: '0x' + '99'.repeat(32),
      contractAddress: '0x' + 'dd'.repeat(20),
      blockTimestamp: 1700000000,
    };
    const anchor = prepareAnchor({ credentialId: 2, foreignEvent }, bridgeStore);
    confirmAnchor(anchor.txHash, 8, bridgeStore);

    await expect(
      verifyAnchorReceiptProof(
        {
          anchorId: 8,
          logIndexInReceipt: 0,
          receiptProof: {
            claim: { txIndex: 0, txType: 0, status: 1, cumulativeGasUsed: '1', logsBloom: '0x' + '00'.repeat(256), logs: [] },
            proofNodes: [],
          },
        },
        bridgeStore,
        headerStore,
      ),
    ).rejects.toThrow(/No checkpointed header/);
  });
});
