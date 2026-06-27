import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => ReturnType<typeof SimulateCallType>;
};

type GdprRequestStatus = 'pending_consent' | 'anonymized' | 'rejected';

type GdprRequest = {
  requestId: string;
  credentialId: number;
  requestedAt: string;
  status: GdprRequestStatus;
  attestorConsents: string[];
  requiredConsents: number;
};

const requests = new Map<string, GdprRequest>();
let requestCounter = 0;

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

export function createGdprRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * POST /api/gdpr/request
   * Submit a GDPR right-to-be-forgotten request for a credential.
   * The credential will be anonymized once all current attestors consent.
   * Body: { credentialId: number }
   */
  router.post('/request', async (req: Request, res: Response) => {
    const { credentialId } = req.body as { credentialId?: unknown };

    if (typeof credentialId !== 'number' || !Number.isInteger(credentialId) || credentialId <= 0) {
      res.status(400).json({ error: 'credentialId must be a positive integer' });
      return;
    }

    let attestors: unknown[] = [];
    try {
      const raw = await soroban.simulateCall('get_attestors', [soroban.u64Val(credentialId)]);
      attestors = Array.isArray(raw) ? raw : [];
    } catch {
      try {
        await soroban.simulateCall('get_credential', [soroban.u64Val(credentialId)]);
      } catch {
        res.status(404).json({ error: 'Credential not found' });
        return;
      }
    }

    requestCounter += 1;
    const requestId = `gdpr_${requestCounter}`;
    const gdprRequest: GdprRequest = {
      requestId,
      credentialId,
      requestedAt: new Date().toISOString(),
      status: attestors.length === 0 ? 'anonymized' : 'pending_consent',
      attestorConsents: [],
      requiredConsents: attestors.length,
    };
    requests.set(requestId, gdprRequest);

    res.status(201).json(serializeBigInt(gdprRequest));
  });

  /**
   * GET /api/gdpr/request/:requestId
   * Get the status of a GDPR request.
   */
  router.get('/request/:requestId', (req: Request, res: Response) => {
    const gdprRequest = requests.get(req.params.requestId);
    if (!gdprRequest) {
      res.status(404).json({ error: 'GDPR request not found' });
      return;
    }
    res.json(gdprRequest);
  });

  /**
   * POST /api/gdpr/consent
   * An attestor submits consent for a pending GDPR deletion/anonymization request.
   * When all required attestors have consented, the credential is marked anonymized.
   * Body: { requestId: string, attestorAddress: string }
   */
  router.post('/consent', (req: Request, res: Response) => {
    const { requestId, attestorAddress } = req.body as {
      requestId?: string;
      attestorAddress?: string;
    };

    if (!requestId || !requests.has(requestId)) {
      res.status(400).json({ error: 'Invalid or unknown requestId' });
      return;
    }
    if (!attestorAddress || typeof attestorAddress !== 'string' || attestorAddress.trim() === '') {
      res.status(400).json({ error: 'attestorAddress is required' });
      return;
    }

    const gdprRequest = requests.get(requestId)!;

    if (gdprRequest.status !== 'pending_consent') {
      res.status(400).json({ error: `Request is already ${gdprRequest.status}` });
      return;
    }

    const addr = attestorAddress.trim();
    if (!gdprRequest.attestorConsents.includes(addr)) {
      gdprRequest.attestorConsents.push(addr);
    }

    if (
      gdprRequest.requiredConsents > 0 &&
      gdprRequest.attestorConsents.length >= gdprRequest.requiredConsents
    ) {
      gdprRequest.status = 'anonymized';
    }

    res.json(gdprRequest);
  });

  return router;
}

import { simulateCall, u64Val } from '../soroban.js';
export default createGdprRouter({
  simulateCall,
  u64Val: u64Val as SorobanClient['u64Val'],
});
