/**
 * Issue #880 — Cross-Chain Interoperability API Routes
 *
 * Routes:
 *   GET  /api/bridge/chains                  — list supported chains
 *   POST /api/bridge/anchors                 — submit a foreign-chain event to anchor
 *   GET  /api/bridge/anchors                 — list all confirmed anchors
 *   GET  /api/bridge/anchors/pending         — list pending (not yet on-chain) anchors
 *   GET  /api/bridge/anchors/:id             — get anchor by on-chain ID
 *   GET  /api/bridge/credentials/:id/anchors — get all anchors for a credential
 *   POST /api/bridge/anchors/:id/verify      — mark anchor as proof-verified
 */
import { Router, Request, Response } from 'express';
import { simulateCall, u64Val, u32Val, addressVal } from '../soroban.js';
import {
  SUPPORTED_CHAINS,
  ProofType,
  prepareAnchor,
  confirmAnchor,
  markVerified,
  getPendingAnchors,
  getAnchorByTxHash,
  getAnchorById,
  getAllAnchors,
  getSupportedChains,
  computeProofHash,
  type ForeignChainEvent,
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
// POST /api/bridge/anchors
//
// Body:
//   credential_id   number   required – local QuorumProof credential ID
//   chain_id        number   required – EIP-155 chain ID
//   tx_hash         string   required – 0x-prefixed 32-byte tx hash
//   block_number    number   required
//   block_timestamp number   required – Unix seconds
//   contract_address string  required – emitting contract on foreign chain
//   event_data      string   required – ABI-encoded log data (hex)
//   zk_proof        string?  optional – raw Groth16/PLONK proof bytes (hex)
//   proof_type      number?  optional – 1=Groth16, 2=PLONK, 3=HashOnly
//   admin           string   required – Stellar admin address
// ---------------------------------------------------------------------------
router.post('/anchors', async (req: Request, res: Response) => {
  const {
    credential_id,
    chain_id,
    tx_hash,
    block_number,
    block_timestamp,
    contract_address,
    event_data,
    zk_proof,
    proof_type,
    admin,
  } = req.body as Record<string, unknown>;

  // Validate required fields
  const missingFields: string[] = [];
  if (typeof credential_id !== 'number') missingFields.push('credential_id');
  if (typeof chain_id !== 'number') missingFields.push('chain_id');
  if (typeof tx_hash !== 'string') missingFields.push('tx_hash');
  if (typeof block_number !== 'number') missingFields.push('block_number');
  if (typeof block_timestamp !== 'number') missingFields.push('block_timestamp');
  if (typeof contract_address !== 'string') missingFields.push('contract_address');
  if (typeof event_data !== 'string') missingFields.push('event_data');
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
    contractAddress: (contract_address as string).toLowerCase(),
    eventData: (event_data as string),
    blockTimestamp: block_timestamp as number,
  };

  const ptCode = typeof proof_type === 'number' ? proof_type : (zk_proof ? ProofType.Groth16 : ProofType.HashOnly);

  const pending = prepareAnchor({
    credentialId: credential_id as number,
    foreignEvent,
    zkProof: typeof zk_proof === 'string' ? zk_proof : undefined,
    proofType: ptCode as ProofType,
  });

  // Build Soroban args
  const { nativeToScVal } = await import('@stellar/stellar-sdk');
  const txHashBuf = Buffer.from(txHashStr.replace(/^0x/, ''), 'hex');
  const proofHashBuf = computeProofHash(foreignEvent, typeof zk_proof === 'string' ? zk_proof : undefined);

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
    pending.anchorId = anchorId;

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
  // Try to get count from chain, fall back to in-memory store
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
    // Fallback to in-memory
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
    // Fallback to in-memory
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
    // Fallback to in-memory
    const anchors = getAllAnchors().filter((a) => a.credentialId === credId);
    res.json({ credential_id: credId, anchors });
  }
});

// ---------------------------------------------------------------------------
// POST /api/bridge/anchors/:id/verify
//
// Body: { admin: string }
// ---------------------------------------------------------------------------
router.post('/anchors/:id/verify', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid anchor ID' });
    return;
  }

  const { admin } = req.body as { admin?: unknown };
  if (typeof admin !== 'string' || admin.length === 0) {
    res.status(400).json({ error: 'admin (Stellar address) is required' });
    return;
  }

  try {
    await simulateCall('verify_chain_anchor', [addressVal(admin), u64Val(id)]);
    markVerified(id);
    res.json({ success: true, anchor_id: id, verified: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('InvalidInput')) {
      res.status(404).json({ error: 'Anchor not found' });
    } else if (msg.includes('UnauthorizedAction')) {
      res.status(403).json({ error: 'Only the contract admin may verify anchors' });
    } else {
      // Mark in-memory even if contract call is simulated
      markVerified(id);
      res.status(202).json({
        message: 'Verified in bridge memory (on-chain update pending)',
        anchor_id: id,
        simulation_error: msg,
      });
    }
  }
});

export default router;
