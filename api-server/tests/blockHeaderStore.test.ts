import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BlockHeaderStore, HeaderVerificationError } from '../src/services/blockHeaderStore.js';
import {
  BeaconLightClientStore,
  hashTreeRootBeaconBlockHeader,
  hashTreeRootSyncCommittee,
  _setDefaultBeaconLightClientStoreForTest,
  type LightClientBootstrap,
  type SyncCommittee,
} from '../src/services/beaconLightClient.js';
import { merkleize } from '../src/services/ssz.js';
import { merkleProofForLeaf } from './helpers/merkleTree.js';

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

  describe('light-client finality mode (integration with beaconLightClient.ts)', () => {
    let lightClientDataDir: string;

    afterEach(() => {
      _setDefaultBeaconLightClientStoreForTest(undefined);
      fs.rmSync(lightClientDataDir, { recursive: true, force: true });
    });

    // Bootstraps a fresh light client whose finalized header's bodyRoot Merkle-commits to the
    // real mainnet-finalized fixture's block hash at EXECUTION_PAYLOAD_BLOCK_HASH_GINDEX (812),
    // and returns the proof a caller would submit alongside that header. Bootstrap only needs a
    // Merkle proof (no BLS signing), so this doesn't need real committee keys — SyncCommittee's
    // hash_tree_root doesn't validate its pubkey bytes are real curve points.
    function bootstrapLightClientForFixture(mainnetHeader: { hash: string }) {
      const blockHash = Buffer.from(mainnetHeader.hash.slice(2), 'hex');
      const bodyLeaves = Array.from({ length: 512 }, (_, i) => new Uint8Array(32).fill(i % 256));
      bodyLeaves[812 - 512] = blockHash; // depth-9 tree, gindex 812 -> position 300
      const bodyRoot = merkleize(bodyLeaves);
      const proof = merkleProofForLeaf(bodyLeaves, 812 - 512);

      const dummyCommittee: SyncCommittee = {
        pubkeys: Array.from({ length: 512 }, (_, i) => new Uint8Array(48).fill(i % 256)),
        aggregatePubkey: new Uint8Array(48).fill(1),
      };
      const stateLeaves = Array.from({ length: 32 }, (_, i) => new Uint8Array(32).fill(i));
      stateLeaves[22] = hashTreeRootSyncCommittee(dummyCommittee); // gindex 54 - 32 = 22

      lightClientDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-lc-integration-'));
      const lightClientStore = new BeaconLightClientStore(lightClientDataDir);
      _setDefaultBeaconLightClientStoreForTest(lightClientStore);

      const bootstrapHeader = { slot: 300000 * 32, proposerIndex: 0, parentRoot: new Uint8Array(32), stateRoot: merkleize(stateLeaves), bodyRoot };
      const trustedBlockRoot = hashTreeRootBeaconBlockHeader(bootstrapHeader);
      const bootstrap: LightClientBootstrap = {
        header: { beacon: bootstrapHeader },
        currentSyncCommittee: dummyCommittee,
        currentSyncCommitteeBranch: merkleProofForLeaf(stateLeaves, 22),
      };
      lightClientStore.bootstrap(1, trustedBlockRoot, bootstrap);

      return { proof: proof.map((b) => ('0x' + Buffer.from(b).toString('hex')) as `0x${string}`) };
    }

    it('checkpoints a genuine mainnet header via light-client finality', () => {
      const header = loadFixture('mainnet-finalized');
      const { proof } = bootstrapLightClientForFixture(header);
      const checkpointed = store.checkpoint({
        chainId: 1,
        rpcHeader: header,
        finality: { mode: 'light-client', executionPayloadProof: proof },
      });
      expect(checkpointed.finalityMode).toBe('light-client');
    });

    it('rejects light-client finality when no light client has been bootstrapped for the chain', () => {
      const header = loadFixture('mainnet-finalized');
      _setDefaultBeaconLightClientStoreForTest(new BeaconLightClientStore(fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-lc-empty-'))));
      expect(() =>
        store.checkpoint({ chainId: 1, rpcHeader: header, finality: { mode: 'light-client', executionPayloadProof: ['0x' + '00'.repeat(32)] } }),
      ).toThrow(HeaderVerificationError);
    });

    it('rejects light-client finality for a chain with no beacon-chain mapping (Polygon)', () => {
      const header = loadFixture('polygon-finalized');
      expect(() =>
        store.checkpoint({ chainId: 137, rpcHeader: header, finality: { mode: 'light-client', executionPayloadProof: ['0x' + '00'.repeat(32)] } }),
      ).toThrow(HeaderVerificationError);
    });

    it('rejects a tampered execution-payload proof', () => {
      const header = loadFixture('mainnet-finalized');
      const { proof } = bootstrapLightClientForFixture(header);
      const tamperedProof = [...proof];
      tamperedProof[0] = '0x' + 'ff'.repeat(32);
      expect(() =>
        store.checkpoint({ chainId: 1, rpcHeader: header, finality: { mode: 'light-client', executionPayloadProof: tamperedProof as `0x${string}`[] } }),
      ).toThrow(HeaderVerificationError);
    });
  });
});
