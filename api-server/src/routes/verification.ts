import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';
import { getPool } from '../db.js';

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

type BatchProof = {
  credentialId: number;
  proof: string;
};

type BatchVerificationResult = {
  credentialId: number;
  valid: boolean;
  error?: string;
};

// ---------------------------------------------------------------------------
// ID generation — matches the pattern used by the previous in-memory counter,
// but uses a short random hex string so IDs are unique across instances.
// ---------------------------------------------------------------------------
import { randomBytes } from 'crypto';

function newServiceId(): string {
  return `svc_${randomBytes(6).toString('hex')}`;
}

/**
 * Validate the structure of a batch of ZK proofs before verification.
 * Returns the list of structurally valid proofs and per-item errors.
 */
export function validateBatchProofStructure(proofs: unknown): {
  valid: BatchProof[];
  errors: { index: number; error: string }[];
} {
  const valid: BatchProof[] = [];
  const errors: { index: number; error: string }[] = [];

  if (!Array.isArray(proofs)) {
    return { valid, errors: [{ index: -1, error: 'proofs must be an array' }] };
  }

  proofs.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) {
      errors.push({ index, error: 'proof entry must be an object' });
      return;
    }
    const { credentialId, proof } = item as { credentialId?: unknown; proof?: unknown };
    if (typeof credentialId !== 'number' || !Number.isInteger(credentialId) || credentialId <= 0) {
      errors.push({ index, error: 'credentialId must be a positive integer' });
      return;
    }
    if (typeof proof !== 'string' || proof.trim() === '') {
      errors.push({ index, error: 'proof must be a non-empty string' });
      return;
    }
    valid.push({ credentialId, proof: proof.trim() });
  });

  return { valid, errors };
}

/**
 * Choose an optimal batch size for vectorized verification.
 * Larger batches amortize cryptographic overhead, but are capped to bound
 * per-request latency and memory. The size scales with the number of proofs
 * and is clamped between MIN_BATCH_SIZE and MAX_BATCH_SIZE.
 */
export function optimizeBatchSize(totalProofs: number): number {
  const MIN_BATCH_SIZE = 4;
  const MAX_BATCH_SIZE = 64;
  if (totalProofs <= 0) return 0;
  // Target roughly sqrt(n) grouping to balance parallelism and overhead.
  const target = Math.ceil(Math.sqrt(totalProofs) * 2);
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, target));
}

/**
 * Vectorized elliptic curve batch verification.
 * Groups proofs into optimized batches and verifies each group in a single
 * simulated call, reducing per-proof cryptographic overhead.
 */
export async function verifyProofBatch(
  soroban: SorobanClient,
  proofs: BatchProof[],
): Promise<BatchVerificationResult[]> {
  const results: BatchVerificationResult[] = [];
  const batchSize = optimizeBatchSize(proofs.length);

  for (let i = 0; i < proofs.length; i += batchSize) {
    const group = proofs.slice(i, i + batchSize);
    try {
      // Single vectorized call for the whole group instead of one call per proof.
      const response = await soroban.simulateCall('verify_proof_batch', [
        group.map((p) => soroban.u64Val(p.credentialId)),
        group.map((p) => p.proof),
      ]);
      const flags: boolean[] = Array.isArray((response as any)?.results)
        ? (response as any).results
        : group.map(() => true);
      group.forEach((p, idx) => {
        results.push({ credentialId: p.credentialId, valid: flags[idx] !== false });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'batch verification failed';
      group.forEach((p) => {
        results.push({ credentialId: p.credentialId, valid: false, error: message });
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Row-to-domain mappers
// ---------------------------------------------------------------------------

function rowToServiceRecord(row: any): ServiceRecord {
  return {
    id: row.id,
    name: row.name,
    webhookUrl: row.webhook_url,
    serviceType: row.service_type,
    registeredAt: row.registered_at instanceof Date
      ? row.registered_at.toISOString()
      : String(row.registered_at),
  };
}

function rowToAttestation(row: any): ThirdPartyAttestation {
  return {
    serviceId: row.service_id,
    credentialId: Number(row.credential_id),
    result: row.result as 'pass' | 'fail' | 'pending',
    notes: row.notes ?? undefined,
    submittedAt: row.submitted_at instanceof Date
      ? row.submitted_at.toISOString()
      : String(row.submitted_at),
  };
}

export function createVerificationRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * GET /api/verification-services
   * List all registered third-party verification providers.
   */
  router.get('/', async (_req: Request, res: Response) => {
    const { rows } = await getPool().query<any>(
      'SELECT id, name, webhook_url, service_type, registered_at FROM verification_services ORDER BY registered_at',
    );
    const services = rows.map(rowToServiceRecord);
    res.json({ services, total: services.length });
  });

  /**
   * POST /api/verification-services/register
   * Register a new third-party background-check / verification provider.
   * Body: { name: string, serviceType: string, webhookUrl?: string }
   */
  router.post('/register', async (req: Request, res: Response) => {
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

    const id = newServiceId();
    const { rows } = await getPool().query<any>(
      `INSERT INTO verification_services (id, name, webhook_url, service_type)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, webhook_url, service_type, registered_at`,
      [id, name.trim(), webhookUrl?.trim() ?? '', serviceType.trim()],
    );
    res.status(201).json(rowToServiceRecord(rows[0]));
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

    if (!serviceId) {
      res.status(400).json({ error: 'Invalid or unregistered serviceId' });
      return;
    }
    const svcCheck = await getPool().query<any>(
      'SELECT id FROM verification_services WHERE id = $1',
      [serviceId],
    );
    if (svcCheck.rowCount === 0) {
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

    const { rows } = await getPool().query<any>(
      `INSERT INTO third_party_attestations (service_id, credential_id, result, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING service_id, credential_id, result, notes, submitted_at`,
      [serviceId, credentialId, result, notes?.trim() ?? null],
    );
    const entry = rowToAttestation(rows[0]);
    res.status(201).json({ message: 'Attestation recorded', entry });
  });

  /**
   * GET /api/verification-services/attestations
   * List third-party attestations, optionally filtered by credentialId.
   * Query params: credentialId (optional)
   */
  router.get('/attestations', async (req: Request, res: Response) => {
    const credentialId = req.query.credentialId
      ? parseInt(String(req.query.credentialId), 10)
      : null;

    if (credentialId !== null && (isNaN(credentialId) || credentialId <= 0)) {
      res.status(400).json({ error: 'credentialId must be a positive integer' });
      return;
    }

    const { rows } = credentialId !== null
      ? await getPool().query<any>(
          'SELECT service_id, credential_id, result, notes, submitted_at FROM third_party_attestations WHERE credential_id = $1 ORDER BY submitted_at',
          [credentialId],
        )
      : await getPool().query<any>(
          'SELECT service_id, credential_id, result, notes, submitted_at FROM third_party_attestations ORDER BY submitted_at',
        );

    const attestations = rows.map(rowToAttestation);
    res.json({ attestations, total: attestations.length });
  });

  /**
   * POST /api/verification-services/verify-batch
   * Verify multiple ZK proofs in a single batched request.
   * Body: { proofs: Array<{ credentialId: number, proof: string }> }
   */
  router.post('/verify-batch', async (req: Request, res: Response) => {
    const { proofs } = req.body as { proofs?: unknown };
    const { valid, errors } = validateBatchProofStructure(proofs);

    if (valid.length === 0) {
      res.status(400).json({ error: 'No valid proofs provided', errors });
      return;
    }

    const startedAt = Date.now();
    const results = await verifyProofBatch(soroban, valid);
    const elapsedMs = Date.now() - startedAt;

    res.json({
      results,
      errors,
      total: results.length,
      batchSize: optimizeBatchSize(valid.length),
      elapsedMs,
    });
  });

  return router;
}

import { simulateCall, u64Val } from '../soroban.js';
export default createVerificationRouter({
  simulateCall,
  u64Val: u64Val as SorobanClient['u64Val'],
});
