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

/**
 * Fee schedule for supported operations.
 *
 * Each entry defines the base gas cost for an operation plus the per-unit
 * cost applied to the operation's `units` input (e.g. number of credentials,
 * number of attestations). Costs are expressed in stroops (1 XLM = 10,000,000
 * stroops) and are intended as a pre-submission estimate.
 */
export const FEE_SCHEDULE: Record<string, { base: number; perUnit: number; description: string }> = {
  register_service: {
    base: 100_000,
    perUnit: 0,
    description: 'Register a third-party verification service',
  },
  attest: {
    base: 150_000,
    perUnit: 25_000,
    description: 'Submit a third-party attestation for a credential',
  },
  get_credential: {
    base: 50_000,
    perUnit: 0,
    description: 'Read a credential from the Soroban contract',
  },
  list_attestations: {
    base: 75_000,
    perUnit: 10_000,
    description: 'List attestations, optionally filtered by credentialId',
  },
};

const services = new Map<string, ServiceRecord>();
const attestations: ThirdPartyAttestation[] = [];

let idCounter = 0;

/**
 * Cache for slice verification results.
 *
 * Verification is deterministic for a given slice identity + version, so we
 * memoize the computed result and invalidate it whenever the slice is updated.
 * Metrics (hits/misses/evictions) are tracked so the cache can be observed.
 */
export type SliceVerificationResult = {
  sliceId: string;
  version: number;
  verified: boolean;
  verifiedAt: string;
};

export type SliceVerificationCacheMetrics = {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
};

const sliceVerificationCache = new Map<string, SliceVerificationResult>();
const sliceVerificationMetrics = { hits: 0, misses: 0, evictions: 0 };

function sliceCacheKey(sliceId: string, version: number): string {
  return `${sliceId}@${version}`;
}

/**
 * Return the cached verification result for a slice, computing and storing it
 * on a miss. The cache is keyed by slice identity + version so a stale result
 * is never served after a slice update (which bumps the version).
 */
export function getSliceVerification(
  sliceId: string,
  version: number,
  compute: () => boolean,
): SliceVerificationResult {
  const key = sliceCacheKey(sliceId, version);
  const cached = sliceVerificationCache.get(key);
  if (cached) {
    sliceVerificationMetrics.hits += 1;
    return cached;
  }

  sliceVerificationMetrics.misses += 1;
  const result: SliceVerificationResult = {
    sliceId,
    version,
    verified: compute(),
    verifiedAt: new Date().toISOString(),
  };
  sliceVerificationCache.set(key, result);
  return result;
}

/**
 * Invalidate all cached verification results for a slice. Called whenever the
 * slice is updated so subsequent reads recompute against the new version.
 */
export function invalidateSliceVerification(sliceId: string): number {
  let evicted = 0;
  for (const key of Array.from(sliceVerificationCache.keys())) {
    if (key.startsWith(`${sliceId}@`)) {
      sliceVerificationCache.delete(key);
      evicted += 1;
    }
  }
  sliceVerificationMetrics.evictions += evicted;
  return evicted;
}

/**
 * Snapshot of cache metrics for observability endpoints.
 */
export function getSliceVerificationCacheMetrics(): SliceVerificationCacheMetrics {
  return {
    hits: sliceVerificationMetrics.hits,
    misses: sliceVerificationMetrics.misses,
    evictions: sliceVerificationMetrics.evictions,
    size: sliceVerificationCache.size,
  };
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

    // A new attestation changes the verification outcome for the credential's
    // slice, so drop any cached verification result to keep the cache coherent.
    invalidateSliceVerification(String(credentialId));

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
   * GET /api/verification-services/slice-verification
   * Return the (cached) verification result for a slice.
   * Query params: sliceId (required), version (optional, defaults to 1)
   */
  router.get('/slice-verification', (req: Request, res: Response) => {
    const sliceId = req.query.sliceId ? String(req.query.sliceId) : '';
    if (!sliceId) {
      res.status(400).json({ error: 'sliceId is required' });
      return;
    }

    const version = req.query.version ? parseInt(String(req.query.version), 10) : 1;
    if (isNaN(version) || version <= 0) {
      res.status(400).json({ error: 'version must be a positive integer' });
      return;
    }

    const result = getSliceVerification(sliceId, version, () => {
      // Deterministic verification: a slice is verified when it has at least
      // one passing attestation and no failing attestations.
      const related = attestations.filter((a) => String(a.credentialId) === sliceId);
      const hasPass = related.some((a) => a.result === 'pass');
      const hasFail = related.some((a) => a.result === 'fail');
      return hasPass && !hasFail;
    });

    res.json(result);
  });

  /**
   * POST /api/verification-services/slice-verification/invalidate
   * Invalidate cached verification results for a slice after an update.
   * Body: { sliceId: string }
   */
  router.post('/slice-verification/invalidate', (req: Request, res: Response) => {
    const { sliceId } = req.body as { sliceId?: string };
    if (!sliceId || typeof sliceId !== 'string' || sliceId.trim() === '') {
      res.status(400).json({ error: 'sliceId is required' });
      return;
    }

    const evicted = invalidateSliceVerification(sliceId.trim());
    res.json({ sliceId: sliceId.trim(), evicted });
  });

  /**
   * GET /api/verification-services/slice-verification/metrics
   * Expose slice verification cache metrics (hits/misses/evictions/size).
   */
  router.get('/slice-verification/metrics', (_req: Request, res: Response) => {
    res.json(getSliceVerificationCacheMetrics());
  });

  /**
   * POST /api/verification-services/estimate-gas
   * Estimate the gas cost of a verification operation before submitting it.
   * Body: { operation: string, units?: number }
   *
   * Returns the estimated gas in stroops along with the fee schedule entry
   * used for the calculation.
   */
  router.post('/estimate-gas', (req: Request, res: Response) => {
    const { operation, units } = req.body as {
      operation?: string;
      units?: unknown;
    };

    if (!operation || typeof operation !== 'string' || operation.trim() === '') {
      res.status(400).json({ error: 'operation is required' });
      return;
    }

    const schedule = FEE_SCHEDULE[operation.trim()];
    if (!schedule) {
      res.status(400).json({
        error: `Unsupported operation: ${operation}`,
        supportedOperations: Object.keys(FEE_SCHEDULE),
      });
      return;
    }

    let unitCount = 1;
    if (units !== undefined) {
      if (typeof units !== 'number' || !Number.isInteger(units) || units < 0) {
        res.status(400).json({ error: 'units must be a non-negative integer' });
        return;
      }
      unitCount = units;
    }

    const estimatedGas = schedule.base + schedule.perUnit * unitCount;

    res.json({
      operation: operation.trim(),
      units: unitCount,
      estimatedGas,
      currency: 'stroops',
      breakdown: {
        base: schedule.base,
        perUnit: schedule.perUnit,
        units: unitCount,
      },
      description: schedule.description,
    });
  });

  return router;
}

import { simulateCall, u64Val } from '../soroban.js';
export default createVerificationRouter({
  simulateCall,
  u64Val: u64Val as SorobanClient['u64Val'],
});
