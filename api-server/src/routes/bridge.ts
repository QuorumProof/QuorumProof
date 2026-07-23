/**
 * Issue #880 — Cross-Chain Interoperability API Routes
 *
 * Routes:
 *   GET  /api/bridge/chains                  — list supported chains
 *   POST /api/bridge/headers                 — checkpoint a finalized foreign-chain block header
 *   POST /api/bridge/anchors                 — submit a foreign-chain event reference to anchor
 *   GET  /api/bridge/anchors                 — list all confirmed anchors
 *   GET  /api/bridge/anchors/pending         — list pending (not yet on-chain) anchors
 *   GET  /api/bridge/anchors/:id             — get anchor by on-chain ID
 *   GET  /api/bridge/credentials/:id/anchors — get all anchors for a credential
 *   POST /api/bridge/anchors/:id/verify      — verify anchor via Merkle-Patricia receipt proof
 *
 * The Soroban `register_chain_anchor` / `verify_chain_anchor` contract call
 * shapes are unchanged from before this hardening pass — only what backs
 * the `proof_hash` bytes and what gates calling `verify_chain_anchor` at all
 * has changed. See crossChainBridge.ts for the trust-model rationale.
 */
import { Router, Request, Response } from 'express';
import { simulateCall, u64Val, u32Val, addressVal } from '../soroban.js';
import { rbac } from '../middleware/rbac.js';
import {
  SUPPORTED_CHAINS,
  ProofType,
  prepareAnchor,
  confirmAnchor,
  getPendingAnchors,
  getAnchorByTxHash,
  getAnchorById,
  getAllAnchors,
  getSupportedChains,
  computeProofHash,
  checkpointHeader,
  verifyAnchorReceiptProof,
  bootstrapLightClient,
  applyLightClientUpdate,
  HeaderVerificationError,
  ReceiptProofError,
  UnrecognizedLogError,
  AnchorVerificationError,
  LightClientError,
  type ForeignChainEvent,
  type ReceiptProof,
  type LightClientBootstrap,
  type LightClientUpdate,
} from '../services/crossChainBridge.js';

function hex(value: unknown, label: string): Uint8Array {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} must be a 0x-prefixed hex string`);
  }
  return Buffer.from(value.slice(2), 'hex');
}
function hexArray(value: unknown, label: string): Uint8Array[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of 0x-prefixed hex strings`);
  return value.map((v, i) => hex(v, `${label}[${i}]`));
}
function parseLightClientHeader(value: unknown, label: string): { beacon: ReturnType<typeof parseBeaconBlockHeader> } {
  const obj = value as Record<string, unknown> | undefined;
  if (!obj || typeof obj !== 'object' || !obj.beacon) throw new Error(`${label}.beacon is required`);
  return { beacon: parseBeaconBlockHeader(obj.beacon, `${label}.beacon`) };
}
function parseBeaconBlockHeader(value: unknown, label: string) {
  const obj = value as Record<string, unknown> | undefined;
  if (!obj || typeof obj !== 'object') throw new Error(`${label} is required`);
  if (typeof obj.slot !== 'number') throw new Error(`${label}.slot is required`);
  if (typeof obj.proposer_index !== 'number') throw new Error(`${label}.proposer_index is required`);
  return {
    slot: obj.slot,
    proposerIndex: obj.proposer_index,
    parentRoot: hex(obj.parent_root, `${label}.parent_root`),
    stateRoot: hex(obj.state_root, `${label}.state_root`),
    bodyRoot: hex(obj.body_root, `${label}.body_root`),
  };
}
function parseSyncCommittee(value: unknown, label: string) {
  const obj = value as Record<string, unknown> | undefined;
  if (!obj || typeof obj !== 'object') throw new Error(`${label} is required`);
  return {
    pubkeys: hexArray(obj.pubkeys, `${label}.pubkeys`),
    aggregatePubkey: hex(obj.aggregate_pubkey, `${label}.aggregate_pubkey`),
  };
}

const router = Router();

function serializeBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInt);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeBigInt(v)])
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// GET /api/bridge/chains
// ---------------------------------------------------------------------------
router.get('/chains', (_req: Request, res: Response) => {
  res.json({ chains: getSupportedChains() });
});

// ---------------------------------------------------------------------------
// POST /api/bridge/headers
//
// Checkpoint a finalized foreign-chain block header — relay/admin only.
// This is the trust-critical entry point: only headers checkpointed here
// can back a subsequent anchor verification. See blockHeaderStore.ts for
// exactly what is (and isn't) verified.
//
// Body:
//   chain_id  number  required – EIP-155 chain ID
//   header    object  required – raw `eth_getBlockByNumber`/`eth_getBlockByHash` result (full: false)
//   finality  object  required – { mode: 'tag', tag: 'finalized' | 'safe' }
//                              | { mode: 'confirmations', head_block_number: number }
// ---------------------------------------------------------------------------
router.post('/headers', rbac.requirePermission('admin:all'), (req: Request, res: Response) => {
  const { chain_id, header, finality } = req.body as Record<string, unknown>;

  if (typeof chain_id !== 'number') {
    res.status(400).json({ error: 'chain_id is required' });
    return;
  }
  if (!SUPPORTED_CHAINS[chain_id]) {
    res.status(400).json({ error: `Unsupported chain_id ${chain_id}` });
    return;
  }
  if (!header || typeof header !== 'object') {
    res.status(400).json({ error: 'header (raw JSON-RPC block object) is required' });
    return;
  }
  const finalityObj = finality as Record<string, unknown> | undefined;
  if (!finalityObj || typeof finalityObj.mode !== 'string') {
    res.status(400).json({ error: "finality is required: {mode:'tag',tag} or {mode:'confirmations',head_block_number}" });
    return;
  }

  let finalityInput: Parameters<typeof checkpointHeader>[0]['finality'];
  if (finalityObj.mode === 'tag') {
    if (finalityObj.tag !== 'finalized' && finalityObj.tag !== 'safe') {
      res.status(400).json({ error: "finality.tag must be 'finalized' or 'safe'" });
      return;
    }
    finalityInput = { mode: 'tag', tag: finalityObj.tag };
  } else if (finalityObj.mode === 'confirmations') {
    if (typeof finalityObj.head_block_number !== 'number') {
      res.status(400).json({ error: 'finality.head_block_number is required for confirmations mode' });
      return;
    }
    finalityInput = { mode: 'confirmations', headBlockNumber: finalityObj.head_block_number };
  } else if (finalityObj.mode === 'light-client') {
    if (!Array.isArray(finalityObj.execution_payload_proof)) {
      res.status(400).json({ error: 'finality.execution_payload_proof (array of 0x-prefixed hashes) is required for light-client mode' });
      return;
    }
    finalityInput = {
      mode: 'light-client',
      executionPayloadProof: finalityObj.execution_payload_proof as `0x${string}`[],
    };
  } else {
    res.status(400).json({ error: "finality.mode must be 'tag', 'confirmations', or 'light-client'" });
    return;
  }

  try {
    const checkpointed = checkpointHeader({
      chainId: chain_id,
      rpcHeader: header as never,
      finality: finalityInput,
    });
    res.status(201).json(checkpointed);
  } catch (err: unknown) {
    if (err instanceof HeaderVerificationError) {
      res.status(422).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/bridge/anchors
//
// Body:
//   credential_id    number   required – local QuorumProof credential ID
//   chain_id         number   required – EIP-155 chain ID
//   tx_hash          string   required – 0x-prefixed 32-byte tx hash
//   block_number     number   required
//   block_hash       string   required – 0x-prefixed 32-byte block hash (must later be checkpointed)
//   block_timestamp  number   required – Unix seconds
//   contract_address string   required – emitting contract on foreign chain
//   proof_type       number?  optional – 1=Groth16, 2=PLONK, 3=HashOnly (default)
//   admin            string   required – Stellar admin address
//
// This only records an unauthenticated claim from the relay — it does NOT
// establish that the event happened. See POST /anchors/:id/verify.
// ---------------------------------------------------------------------------
router.post('/anchors', async (req: Request, res: Response) => {
  const {
    credential_id,
    chain_id,
    tx_hash,
    block_number,
    block_hash,
    block_timestamp,
    contract_address,
    proof_type,
    admin,
  } = req.body as Record<string, unknown>;

  const missingFields: string[] = [];
  if (typeof credential_id !== 'number') missingFields.push('credential_id');
  if (typeof chain_id !== 'number') missingFields.push('chain_id');
  if (typeof tx_hash !== 'string') missingFields.push('tx_hash');
  if (typeof block_number !== 'number') missingFields.push('block_number');
  if (typeof block_hash !== 'string') missingFields.push('block_hash');
  if (typeof block_timestamp !== 'number') missingFields.push('block_timestamp');
  if (typeof contract_address !== 'string') missingFields.push('contract_address');
  if (typeof admin !== 'string') missingFields.push('admin (Stellar admin address)');

  if (missingFields.length > 0) {
    res.status(400).json({ error: `Missing required fields: ${missingFields.join(', ')}` });
    return;
  }

  if (!SUPPORTED_CHAINS[chain_id as number]) {
    res.status(400).json({
      error: `Unsupported chain_id ${chain_id}. Supported: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`,
    });
    return;
  }

  const txHashStr = (tx_hash as string).toLowerCase();
  const existing = getAnchorByTxHash(txHashStr);
  if (existing?.anchorId !== null && existing !== undefined) {
    res.status(409).json({
      error: 'This transaction hash has already been anchored',
      anchor_id: existing.anchorId,
    });
    return;
  }

  const foreignEvent: ForeignChainEvent = {
    chainId: chain_id as number,
    txHash: txHashStr,
    blockNumber: block_number as number,
    blockHash: (block_hash as string).toLowerCase(),
    contractAddress: (contract_address as string).toLowerCase(),
    blockTimestamp: block_timestamp as number,
  };

  const ptCode = typeof proof_type === 'number' ? proof_type : ProofType.HashOnly;

  let pending;
  try {
    pending = prepareAnchor({
      credentialId: credential_id as number,
      foreignEvent,
      proofType: ptCode as ProofType,
    });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const { nativeToScVal } = await import('@stellar/stellar-sdk');
  const txHashBuf = Buffer.from(txHashStr.replace(/^0x/, ''), 'hex');
  const proofHashBuf = computeProofHash(foreignEvent);

  // foreign_tx must be ≤ 64 bytes
  const foreignTxBytes = txHashBuf.length <= 64 ? txHashBuf : txHashBuf.slice(0, 64);

  try {
    const anchorIdRaw = await simulateCall('register_chain_anchor', [
      addressVal(admin as string),
      u32Val(chain_id as number),
      u64Val(credential_id as number),
      nativeToScVal(foreignTxBytes, { type: 'bytes' }),
      nativeToScVal(proofHashBuf, { type: 'bytes' }),
      u32Val(ptCode),
    ]);

    const anchorId = Number(anchorIdRaw);
    confirmAnchor(txHashStr, anchorId);

    res.status(201).json({
      anchor_id: anchorId,
      credential_id: pending.credentialId,
      chain_id: pending.chainId,
      chain_name: pending.chainName,
      tx_hash: pending.txHash,
      proof_hash: pending.proofHash,
      proof_type: pending.proofType,
      anchored_at: pending.anchoredAt,
      verified: false,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('CredentialNotFound')) {
      res.status(404).json({ error: 'Credential not found on Stellar' });
    } else if (msg.includes('UnauthorizedAction')) {
      res.status(403).json({ error: 'Only the contract admin may register anchors' });
    } else {
      // Return the prepared anchor even if on-chain call is simulated
      res.status(202).json({
        message: 'Anchor prepared (on-chain registration pending — contract may not be deployed)',
        anchor: pending,
        simulation_error: msg,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/bridge/anchors
// ---------------------------------------------------------------------------
router.get('/anchors', async (_req: Request, res: Response) => {
  // Try to get count from chain, fall back to durable store
  try {
    const count = await simulateCall('get_chain_anchor_count', []);
    const total = Number(count);
    const anchors = [];
    for (let i = 1; i <= Math.min(total, 100); i++) {
      try {
        const a = await simulateCall('get_chain_anchor', [u64Val(i)]);
        if (a) anchors.push(serializeBigInt(a));
      } catch {
        // skip missing
      }
    }
    res.json({ total, anchors });
  } catch {
    // Fallback to durable store
    const anchors = getAllAnchors();
    res.json({ total: anchors.length, anchors });
  }
});

// ---------------------------------------------------------------------------
// GET /api/bridge/anchors/pending
// ---------------------------------------------------------------------------
router.get('/anchors/pending', (_req: Request, res: Response) => {
  const pending = getPendingAnchors();
  res.json({ total: pending.length, anchors: pending });
});

// ---------------------------------------------------------------------------
// GET /api/bridge/anchors/:id
// ---------------------------------------------------------------------------
router.get('/anchors/:id', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid anchor ID' });
    return;
  }

  try {
    const anchor = await simulateCall('get_chain_anchor', [u64Val(id)]);
    if (!anchor) {
      res.status(404).json({ error: 'Anchor not found' });
      return;
    }
    res.json(serializeBigInt(anchor));
  } catch {
    // Fallback to durable store
    const anchor = getAnchorById(id);
    if (!anchor) {
      res.status(404).json({ error: 'Anchor not found' });
      return;
    }
    res.json(anchor);
  }
});

// ---------------------------------------------------------------------------
// GET /api/bridge/credentials/:id/anchors
// ---------------------------------------------------------------------------
router.get('/credentials/:id/anchors', async (req: Request, res: Response) => {
  const credId = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(credId) || credId <= 0) {
    res.status(400).json({ error: 'Invalid credential ID' });
    return;
  }

  try {
    const ids: bigint[] = await simulateCall('get_credential_anchors', [u64Val(credId)]);
    const anchors = await Promise.all(
      (ids ?? []).map(async (aid) => {
        try {
          return serializeBigInt(await simulateCall('get_chain_anchor', [u64Val(Number(aid))]));
        } catch {
          return null;
        }
      })
    );
    res.json({ credential_id: credId, anchors: anchors.filter(Boolean) });
  } catch {
    // Fallback to durable store
    const anchors = getAllAnchors().filter((a) => a.credentialId === credId);
    res.json({ credential_id: credId, anchors });
  }
});

// ---------------------------------------------------------------------------
// POST /api/bridge/anchors/:id/verify
//
// Body:
//   admin          string  required – Stellar address
//   log_index      number  required – index of the credential log within the receipt
//   receipt_proof  object  required – {
//     claim: { txIndex, txType, status, cumulativeGasUsed, logsBloom, logs },
//     proofNodes: string[],   // 0x-prefixed trie nodes, root to leaf
//   }
//
// The anchor's registered (chainId, blockHash) must already have a header
// checkpointed via POST /headers. The receipt proof is verified against
// that header's receiptsRoot before verify_chain_anchor is ever called.
// ---------------------------------------------------------------------------
router.post('/anchors/:id/verify', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid anchor ID' });
    return;
  }

  const { admin, log_index, receipt_proof } = req.body as {
    admin?: unknown;
    log_index?: unknown;
    receipt_proof?: unknown;
  };
  if (typeof admin !== 'string' || admin.length === 0) {
    res.status(400).json({ error: 'admin (Stellar address) is required' });
    return;
  }
  if (typeof log_index !== 'number') {
    res.status(400).json({ error: 'log_index is required' });
    return;
  }
  if (!receipt_proof || typeof receipt_proof !== 'object') {
    res.status(400).json({ error: 'receipt_proof is required' });
    return;
  }

  let verification;
  try {
    verification = await verifyAnchorReceiptProof({
      anchorId: id,
      logIndexInReceipt: log_index,
      receiptProof: receipt_proof as ReceiptProof,
    });
  } catch (err: unknown) {
    if (err instanceof AnchorVerificationError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof ReceiptProofError || err instanceof UnrecognizedLogError) {
      res.status(422).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  try {
    await simulateCall('verify_chain_anchor', [addressVal(admin), u64Val(id)]);
    res.json({
      success: true,
      anchor_id: id,
      verified: true,
      decoded_event: verification.decoded,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('InvalidInput')) {
      res.status(404).json({ error: 'Anchor not found' });
    } else if (msg.includes('UnauthorizedAction')) {
      res.status(403).json({ error: 'Only the contract admin may verify anchors' });
    } else {
      // Off-chain proof verification already succeeded and is durably
      // recorded; only the on-chain confirmation is pending.
      res.status(202).json({
        message: 'Proof verified and recorded (on-chain update pending — contract may not be deployed)',
        anchor_id: id,
        verified: true,
        decoded_event: verification.decoded,
        simulation_error: msg,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// POST /api/bridge/light-client/bootstrap
//
// Establishes the light client's trust anchor for a beacon-chain network
// (mainnet/Sepolia — see beaconChainConfig.ts) from a weak-subjectivity
// checkpoint. `trusted_block_root` must come from an out-of-band source (a
// checkpoint-sync provider, or your own beacon node) — see
// beaconLightClient.ts's module doc for why that's the one fact this whole
// chain of trust rests on. Relay/admin only.
//
// Body:
//   chain_id            number  required
//   trusted_block_root  string  required – 0x-prefixed 32-byte beacon block root
//   bootstrap            object required – {
//     header: { beacon: { slot, proposer_index, parent_root, state_root, body_root } },
//     current_sync_committee: { pubkeys: string[512], aggregate_pubkey: string },
//     current_sync_committee_branch: string[],
//   }
// ---------------------------------------------------------------------------
router.post('/light-client/bootstrap', rbac.requirePermission('admin:all'), (req: Request, res: Response) => {
  const { chain_id, trusted_block_root, bootstrap } = req.body as Record<string, unknown>;
  if (typeof chain_id !== 'number') {
    res.status(400).json({ error: 'chain_id is required' });
    return;
  }
  try {
    const trustedBlockRoot = hex(trusted_block_root, 'trusted_block_root');
    const bootstrapObj = bootstrap as Record<string, unknown> | undefined;
    if (!bootstrapObj || typeof bootstrapObj !== 'object') throw new Error('bootstrap is required');
    const parsed: LightClientBootstrap = {
      header: parseLightClientHeader(bootstrapObj.header, 'bootstrap.header'),
      currentSyncCommittee: parseSyncCommittee(bootstrapObj.current_sync_committee, 'bootstrap.current_sync_committee'),
      currentSyncCommitteeBranch: hexArray(bootstrapObj.current_sync_committee_branch, 'bootstrap.current_sync_committee_branch'),
    };
    bootstrapLightClient(chain_id, trustedBlockRoot, parsed);
    res.status(201).json({ success: true, chain_id });
  } catch (err: unknown) {
    if (err instanceof LightClientError) {
      res.status(422).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/bridge/light-client/update
//
// Feeds the light client a new sync-committee-signed update, advancing its
// finalized header when (and only when) a real supermajority BLS aggregate
// signature verifies. See beaconLightClient.ts for the full protocol. Relay
// only — this only ever advances state via cryptographic verification, so a
// malicious relay can at worst submit garbage that gets rejected.
//
// Body:
//   chain_id   number  required
//   update     object  required – {
//     attested_header, next_sync_committee?, next_sync_committee_branch?,
//     finalized_header?, finality_branch?, signature_slot: number,
//     sync_aggregate: { sync_committee_bits: boolean[512], sync_committee_signature: string },
//   }
// ---------------------------------------------------------------------------
router.post('/light-client/update', rbac.requirePermission('admin:all'), (req: Request, res: Response) => {
  const { chain_id, update } = req.body as Record<string, unknown>;
  if (typeof chain_id !== 'number') {
    res.status(400).json({ error: 'chain_id is required' });
    return;
  }
  try {
    const updateObj = update as Record<string, unknown> | undefined;
    if (!updateObj || typeof updateObj !== 'object') throw new Error('update is required');
    if (typeof updateObj.signature_slot !== 'number') throw new Error('update.signature_slot is required');
    const syncAggregate = updateObj.sync_aggregate as Record<string, unknown> | undefined;
    if (!syncAggregate || !Array.isArray(syncAggregate.sync_committee_bits)) {
      throw new Error('update.sync_aggregate.sync_committee_bits (boolean[512]) is required');
    }

    const parsed: LightClientUpdate = {
      attestedHeader: parseLightClientHeader(updateObj.attested_header, 'update.attested_header'),
      signatureSlot: updateObj.signature_slot,
      syncAggregate: {
        syncCommitteeBits: syncAggregate.sync_committee_bits as boolean[],
        syncCommitteeSignature: hex(syncAggregate.sync_committee_signature, 'update.sync_aggregate.sync_committee_signature'),
      },
    };
    if (updateObj.next_sync_committee) {
      parsed.nextSyncCommittee = parseSyncCommittee(updateObj.next_sync_committee, 'update.next_sync_committee');
      parsed.nextSyncCommitteeBranch = hexArray(updateObj.next_sync_committee_branch, 'update.next_sync_committee_branch');
    }
    if (updateObj.finalized_header) {
      parsed.finalizedHeader = parseLightClientHeader(updateObj.finalized_header, 'update.finalized_header');
      parsed.finalityBranch = hexArray(updateObj.finality_branch, 'update.finality_branch');
    }

    const finalized = applyLightClientUpdate(chain_id, parsed);
    res.json({
      success: true,
      chain_id,
      finalized_header: {
        slot: finalized.beacon.slot,
        state_root: bytesToHexString(finalized.beacon.stateRoot),
        body_root: bytesToHexString(finalized.beacon.bodyRoot),
      },
    });
  } catch (err: unknown) {
    if (err instanceof LightClientError) {
      res.status(422).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function bytesToHexString(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}

export default router;
