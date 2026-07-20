/**
 * Durable, checkpointed block-header store — Issue #880 hardening.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRUST ASSUMPTION (read this before relying on this module)
 * ─────────────────────────────────────────────────────────────────────────
 * This module does NOT implement a full light client. It does not verify
 * proof-of-work difficulty chains or PoS sync-committee/attestation
 * signatures, and it does not independently determine chain-of-most-work.
 *
 * What it DOES verify, cryptographically, on every checkpoint:
 *   1. Header self-consistency: the claimed `blockHash` is recomputed from
 *      the full RLP-encoded header fields (via @ethereumjs/block) and must
 *      match exactly. A relay cannot hand us header fields (in particular
 *      `receiptsRoot`) that don't correspond to the block hash it claims —
 *      that would require a keccak256 preimage attack.
 *   2. Finality: the header is only accepted if the relay fetched it via
 *      the chain's `finalized` (or `safe`) RPC tag, or — as a fallback for
 *      relays that can't supply one — is at least `MIN_CONFIRMATIONS[chainId]`
 *      blocks behind the relay-reported chain head.
 *   3. Non-conflicting checkpoints: if a later checkpoint at the same
 *      (chainId, blockNumber) claims a *different* block hash than one
 *      already checkpointed, that would mean a "finalized" block reorged —
 *      which should be cryptographically impossible for genuinely finalized
 *      blocks. We refuse it loudly rather than silently overwrite.
 *
 * The trust that remains, precisely: **we trust the RPC endpoint(s) the
 * relay is connected to to honestly report which block is canonical /
 * finalized at a given height.** A relay (or its upstream RPC provider)
 * that is malicious or compromised could feed us a self-consistent,
 * internally-valid header for a block that never became canonical. We do
 * not defend against that here — mitigating it further would mean
 * cross-checking multiple independent RPC providers (an operational
 * relay-diversity concern, not something one service instance can verify
 * offline) or a real light client (BLS sync-committee verification for
 * post-Merge Ethereum, or a PoW/validator-set client for other chains).
 *
 * This replaces a strictly weaker model: previously, any anchor's
 * "cryptographic" backing was an HMAC keyed by a single shared secret
 * (`BRIDGE_HMAC_SECRET`) — anyone holding that one secret could forge any
 * anchor for any chain, with no dependency on real chain state at all. The
 * trust surface here is narrower (an honest RPC view of canonical/finalized
 * chain state, per chain) and, unlike a leaked static secret, is exactly
 * the trust model most production bridges that don't run a full light
 * client (e.g. optimistic/attested bridges) openly operate under.
 */
import path from 'path';
import { createBlockHeaderFromRPC, type JSONRPCBlock } from '@ethereumjs/block';
import { bytesToHex } from '@ethereumjs/util';
import { DurableLog } from './durableLog.js';
import { headerSchemaForChain, MIN_CONFIRMATIONS } from './evmChainConfig.js';

export type FinalityMode = 'tag' | 'confirmations';

export interface CheckpointHeaderInput {
  chainId: number;
  /** Raw `eth_getBlockByNumber`/`eth_getBlockByHash` result (with full: false) for the header being checkpointed. */
  rpcHeader: JSONRPCBlock;
  finality:
    | { mode: 'tag'; tag: 'finalized' | 'safe' }
    | { mode: 'confirmations'; headBlockNumber: number };
}

export interface CheckpointedHeader {
  chainId: number;
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  receiptsRoot: string;
  timestamp: number;
  finalityMode: FinalityMode;
  checkpointedAt: string;
}

export class HeaderVerificationError extends Error {}

function hexToNumber(hex: string): number {
  return Number.parseInt(hex, 16);
}

export class BlockHeaderStore {
  private readonly log: DurableLog<CheckpointedHeader>;

  constructor(dataDir?: string) {
    const dir = dataDir ?? process.env.BRIDGE_STORE_DATA_DIR ?? path.join(process.cwd(), '.data', 'bridge');
    this.log = new DurableLog<CheckpointedHeader>(path.join(dir, 'checkpointed-headers.jsonl'));
  }

  private key(chainId: number, blockHash: string): string {
    return `${chainId}:${blockHash.toLowerCase()}`;
  }

  private numberKey(chainId: number, blockNumber: number): string {
    return `num:${chainId}:${blockNumber}`;
  }

  /**
   * Verify and persist a checkpointed header. Throws `HeaderVerificationError`
   * if the header fails self-consistency, fails the finality requirement, or
   * conflicts with an already-checkpointed header at the same height.
   */
  checkpoint(input: CheckpointHeaderInput): CheckpointedHeader {
    const { chainId, rpcHeader, finality } = input;

    const schema = headerSchemaForChain(chainId);
    let computedHash: string;
    try {
      const header = createBlockHeaderFromRPC(rpcHeader, {
        common: schema.common,
        setHardfork: schema.setHardfork,
        skipConsensusFormatValidation: true,
      });
      computedHash = bytesToHex(header.hash());
    } catch (err) {
      throw new HeaderVerificationError(
        `Header RLP encoding failed for chain ${chainId} block ${rpcHeader.number}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (computedHash.toLowerCase() !== rpcHeader.hash.toLowerCase()) {
      throw new HeaderVerificationError(
        `Header self-consistency check failed for chain ${chainId} block ${rpcHeader.number}: ` +
          `recomputed hash ${computedHash} does not match claimed hash ${rpcHeader.hash}`,
      );
    }

    const blockNumber = hexToNumber(rpcHeader.number);

    let finalityMode: FinalityMode;
    if (finality.mode === 'tag') {
      finalityMode = 'tag';
    } else {
      const required = MIN_CONFIRMATIONS[chainId] ?? Number.POSITIVE_INFINITY;
      const confirmations = finality.headBlockNumber - blockNumber;
      if (confirmations < required) {
        throw new HeaderVerificationError(
          `Chain ${chainId} block ${blockNumber} has only ${confirmations} confirmations; ` +
            `requires ${required} without a finalized/safe tag`,
        );
      }
      finalityMode = 'confirmations';
    }

    const numKey = this.numberKey(chainId, blockNumber);
    const existingHashAtHeight = this.log.get(numKey);
    if (existingHashAtHeight && existingHashAtHeight.blockHash.toLowerCase() !== rpcHeader.hash.toLowerCase()) {
      throw new HeaderVerificationError(
        `Conflicting checkpoint for chain ${chainId} block ${blockNumber}: ` +
          `already checkpointed as ${existingHashAtHeight.blockHash}, now claimed as ${rpcHeader.hash}. ` +
          `A "finalized" block should never change — refusing to overwrite.`,
      );
    }

    const record: CheckpointedHeader = {
      chainId,
      blockNumber,
      blockHash: rpcHeader.hash.toLowerCase(),
      parentHash: rpcHeader.parentHash.toLowerCase(),
      receiptsRoot: rpcHeader.receiptsRoot.toLowerCase(),
      timestamp: hexToNumber(rpcHeader.timestamp),
      finalityMode,
      checkpointedAt: new Date().toISOString(),
    };

    this.log.set(this.key(chainId, rpcHeader.hash), record);
    this.log.set(numKey, record);
    return record;
  }

  getByHash(chainId: number, blockHash: string): CheckpointedHeader | undefined {
    return this.log.get(this.key(chainId, blockHash));
  }

  getByNumber(chainId: number, blockNumber: number): CheckpointedHeader | undefined {
    return this.log.get(this.numberKey(chainId, blockNumber));
  }
}

let defaultStore: BlockHeaderStore | undefined;

export function getDefaultBlockHeaderStore(): BlockHeaderStore {
  if (!defaultStore) defaultStore = new BlockHeaderStore();
  return defaultStore;
}

/** Test-only: force the module to construct a fresh default store. */
export function _setDefaultBlockHeaderStoreForTest(store: BlockHeaderStore | undefined): void {
  defaultStore = store;
}
