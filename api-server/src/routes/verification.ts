import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => any;
};

type ServiceRecord = {
  id: string;
  name: string;
  webhookUrl: string;
  serviceType: string;
  registeredAt: string;
};

type ThirdPartyAttestation = {
  serviceId: string;
  credentialId: number;
  result: 'pass' | 'fail' | 'pending';
  notes?: string;
  submittedAt: string;
};

const services = new Map<string, ServiceRecord>();
const attestations: ThirdPartyAttestation[] = [];

let idCounter = 0;

/**
 * Proof verification memoization.
 *
 * The same proof (identified by its hash) is frequently verified more than
 * once. We cache the verification outcome keyed by the proof hash so that
 * redundant verifications are avoided. The cache is bounded (LRU-style) and
 * entries expire after a TTL so stale results are not served indefinitely.
 */
const PROOF_CACHE_MAX_SIZE = 500;
const PROOF_CACHE_TTL_MS = 5 * 60 * 1000;

type ProofCacheEntry = {
  result: unknown;
  expiresAt: number;
};

const proofCache = new Map<string, ProofCacheEntry>();

function getCachedProof(proofHash: string): unknown | undefined {
  const entry = proofCache.get(proofHash);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    // Invalidation: expired entry is dropped so the next call re-verifies.
    proofCache.delete(proofHash);
    return undefined;
  }
  // Refresh recency for LRU eviction ordering.
  proofCache.delete(proofHash);
  proofCache.set(proofHash, entry);
  return entry.result;
}

function setCachedProof(proofHash: string, result: unknown): void {
  if (proofCache.has(proofHash)) {
    proofCache.delete(proofHash);
  }
  proofCache.set(proofHash, { result, expiresAt: Date.now() + PROOF_CACHE_TTL_MS });
  // Size limit: evict the least-recently-used entry when over capacity.
  while (proofCache.size > PROOF_CACHE_MAX_SIZE) {
    const oldest = proofCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    proofCache.delete(oldest);
  }
}

function invalidateProof(proofHash: string): void {
  proofCache.delete(proofHash);
}

export function createVerificationRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * GET /api/verification-services
   * List all registered third-party verification providers.
   */
  router.get('/', (_req: Request, res: Response) => {
    res.json({ services: Array.from(services.values()), total: services.size });
  });

  /**
   * POST /api/verification-services/register
   * Register a new third-party background-check / verification provider.
   * Body: { name: string, serviceType: string, webhookUrl?: string }
   */
  router.post('/register', (req: Request, res: Response) => {
    const { name, serviceType, webhookUrl } = req.body as {
      name?: string;
      serviceType?: string;
      webhookUrl?: string;
    };

    if (!name || typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!serviceType || typeof serviceType !== 'string' || serviceType.trim() === '') {
      res.status(400).json({ error: 'serviceType is required (e.g. background_check, identity, education)' });
      return;
    }

    idCounter += 1;
    const id = `svc_${idCounter}`;
    const record: ServiceRecord = {
      id,
      name: name.trim(),
      webhookUrl: webhookUrl?.trim() ?? '',
      serviceType: serviceType.trim(),
      registeredAt: new Date().toISOString(),
    };
    services.set(id, record);
    res.status(201).json(record);
  });

  /**
   * POST /api/verification-services/attest
   * A registered third-party service submits an attestation result for a credential.
   * Body: { serviceId: string, credentialId: number, result: 'pass'|'fail'|'pending', notes?: string }
   */
  router.post('/attest', async (req: Request, res: Response) => {
    const { serviceId, credentialId, result, notes } = req.body as {
      serviceId?: string;
      credentialId?: unknown;
      result?: string;
      notes?: string;
    };

    if (!serviceId || !services.has(serviceId)) {
      res.status(400).json({ error: 'Invalid or unregistered serviceId' });
      return;
    }
    if (typeof credentialId !== 'number' || !Number.isInteger(credentialId) || credentialId <= 0) {
      res.status(400).json({ error: 'credentialId must be a positive integer' });
      return;
    }
    if (!['pass', 'fail', 'pending'].includes(result ?? '')) {
      res.status(400).json({ error: 'result must be one of: pass, fail, pending' });
      return;
    }

    try {
      await soroban.simulateCall('get_credential', [soroban.u64Val(credentialId)]);
    } catch {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }

    const entry: ThirdPartyAttestation = {
      serviceId,
      credentialId,
      result: result as 'pass' | 'fail' | 'pending',
      notes: notes?.trim(),
      submittedAt: new Date().toISOString(),
    };
    attestations.push(entry);

    res.status(201).json({ message: 'Attestation recorded', entry });
  });

  /**
   * GET /api/verification-services/attestations
   * List third-party attestations, optionally filtered by credentialId.
   * Query params: credentialId (optional)
   */
  router.get('/attestations', (req: Request, res: Response) => {
    const credentialId = req.query.credentialId
      ? parseInt(String(req.query.credentialId), 10)
      : null;

    if (credentialId !== null && (isNaN(credentialId) || credentialId <= 0)) {
      res.status(400).json({ error: 'credentialId must be a positive integer' });
      return;
    }

    const filtered =
      credentialId !== null
        ? attestations.filter((a) => a.credentialId === credentialId)
        : attestations;

    res.json({ attestations: filtered, total: filtered.length });
  });

  /**
   * POST /api/verification-services/verify-proof
   * Verify a proof, memoizing the outcome by proof hash so repeated
   * verifications of the same proof are served from cache.
   * Body: { proofHash: string, credentialId?: number }
   */
  router.post('/verify-proof', async (req: Request, res: Response) => {
    const { proofHash, credentialId } = req.body as {
      proofHash?: string;
      credentialId?: unknown;
    };

    if (!proofHash || typeof proofHash !== 'string' || proofHash.trim() === '') {
      res.status(400).json({ error: 'proofHash is required' });
      return;
    }

    const key = proofHash.trim();

    // Cache hit: return the memoized verification result.
    const cached = getCachedProof(key);
    if (cached !== undefined) {
      res.json({ proofHash: key, result: cached, cached: true });
      return;
    }

    // Cache miss: fall through to real verification.
    try {
      const args =
        typeof credentialId === 'number' && Number.isInteger(credentialId) && credentialId > 0
          ? [soroban.u64Val(credentialId)]
          : [];
      const result = await soroban.simulateCall('verify_proof', args);
      setCachedProof(key, result);
      res.json({ proofHash: key, result, cached: false });
    } catch {
      res.status(400).json({ error: 'Proof verification failed' });
    }
  });

  /**
   * POST /api/verification-services/invalidate-proof
   * Explicitly invalidate a memoized proof verification result.
   * Body: { proofHash: string }
   */
  router.post('/invalidate-proof', (req: Request, res: Response) => {
    const { proofHash } = req.body as { proofHash?: string };

    if (!proofHash || typeof proofHash !== 'string' || proofHash.trim() === '') {
      res.status(400).json({ error: 'proofHash is required' });
      return;
    }

    invalidateProof(proofHash.trim());
    res.json({ message: 'Proof cache invalidated', proofHash: proofHash.trim() });
  });

  return router;
}

import { simulateCall, u64Val } from '../soroban.js';
export default createVerificationRouter({
  simulateCall,
  u64Val: u64Val as SorobanClient['u64Val'],
});
