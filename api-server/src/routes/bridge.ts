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
  HeaderVerificationError,
  ReceiptProofError,
  UnrecognizedLogError,
  AnchorVerificationError,
  type ForeignChainEvent,
  type ReceiptProof,
} from '../services/crossChainBridge.js';

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
  } else {
    res.status(400).json({ error: "finality.mode must be 'tag' or 'confirmations'" });
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

export default router;
