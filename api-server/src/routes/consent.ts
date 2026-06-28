/**
 * Issue #881 — Credential Holder Consent Management
 *
 * Routes:
 *   GET    /api/credentials/:id/consent/verifiers            — list verifiers who accessed credential
 *   GET    /api/credentials/:id/consent/access-log           — full access log for a credential
 *   GET    /api/credentials/:id/consent/grants/:verifier     — get specific consent grant
 *   POST   /api/credentials/:id/consent/grants               — grant consent to a verifier
 *   DELETE /api/credentials/:id/consent/grants/:verifier     — revoke verifier consent
 *   GET    /api/credentials/:id/consent/grants/:verifier/status — check if consent is active
 *   POST   /api/credentials/:id/consent/access               — record an access event (bridge use)
 */
import { Router, Request, Response } from 'express';
import { simulateCall, u64Val, u32Val, addressVal } from '../soroban.js';

const router = Router({ mergeParams: true });

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

/** Map access_type code to a human-readable label */
const ACCESS_TYPE_LABELS: Record<number, string> = {
  1: 'share_link',
  2: 'delegation',
  3: 'proof_request',
};

function resolveCredentialId(req: Request, res: Response): number | null {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid credential ID' });
    return null;
  }
  return id;
}

// ---------------------------------------------------------------------------
// GET /api/credentials/:id/consent/verifiers
//
// Query: holder=<stellar-address>  (required)
// ---------------------------------------------------------------------------
router.get('/:id/consent/verifiers', async (req: Request, res: Response) => {
  const credentialId = resolveCredentialId(req, res);
  if (credentialId === null) return;

  const { holder } = req.query as Record<string, string>;
  if (!holder) {
    res.status(400).json({ error: 'holder query parameter (Stellar address) is required' });
    return;
  }

  try {
    const verifiers = await simulateCall('get_credential_verifiers', [
      addressVal(holder),
      u64Val(credentialId),
    ]);
    res.json({
      credential_id: credentialId,
      verifiers: serializeBigInt(verifiers ?? []),
      total: Array.isArray(verifiers) ? verifiers.length : 0,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('CredentialNotFound')) {
      res.status(404).json({ error: 'Credential not found' });
    } else if (msg.includes('UnauthorizedAction')) {
      res.status(403).json({ error: 'Only the credential holder may view this data' });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/credentials/:id/consent/access-log
//
// Query: holder=<stellar-address>  (required)
//        verifier=<address>         (optional filter)
//        access_type=1|2|3          (optional filter: 1=share_link, 2=delegation, 3=proof_request)
// ---------------------------------------------------------------------------
router.get('/:id/consent/access-log', async (req: Request, res: Response) => {
  const credentialId = resolveCredentialId(req, res);
  if (credentialId === null) return;

  const { holder, verifier, access_type } = req.query as Record<string, string>;
  if (!holder) {
    res.status(400).json({ error: 'holder query parameter (Stellar address) is required' });
    return;
  }

  try {
    const raw = await simulateCall('get_verifier_access_log', [
      addressVal(holder),
      u64Val(credentialId),
    ]);

    let entries = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;

    // Optional filters
    if (verifier) {
      entries = entries.filter((e) => String(e.verifier).toLowerCase() === verifier.toLowerCase());
    }
    if (access_type) {
      const typeCode = parseInt(access_type, 10);
      entries = entries.filter((e) => Number(e.access_type) === typeCode);
    }

    const serialized = serializeBigInt(entries) as Array<Record<string, unknown>>;

    // Enrich with human-readable access type label
    const enriched = serialized.map((e) => ({
      ...e,
      access_type_label: ACCESS_TYPE_LABELS[Number(e.access_type)] ?? 'unknown',
    }));

    res.json({
      credential_id: credentialId,
      entries: enriched,
      total: enriched.length,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('CredentialNotFound')) {
      res.status(404).json({ error: 'Credential not found' });
    } else if (msg.includes('UnauthorizedAction')) {
      res.status(403).json({ error: 'Only the credential holder may view this data' });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// ---------------------------------------------------------------------------
// POST /api/credentials/:id/consent/grants
//
// Body:
//   holder     string  Stellar address of the credential holder  (required)
//   verifier   string  Stellar address to grant consent to        (required)
//   expires_at number  Unix timestamp (0 = no expiry)             (optional, default 0)
// ---------------------------------------------------------------------------
router.post('/:id/consent/grants', async (req: Request, res: Response) => {
  const credentialId = resolveCredentialId(req, res);
  if (credentialId === null) return;

  const { holder, verifier, expires_at } = req.body as {
    holder?: unknown;
    verifier?: unknown;
    expires_at?: unknown;
  };

  if (typeof holder !== 'string' || holder.length === 0) {
    res.status(400).json({ error: 'holder (Stellar address) is required' });
    return;
  }
  if (typeof verifier !== 'string' || verifier.length === 0) {
    res.status(400).json({ error: 'verifier (Stellar address) is required' });
    return;
  }

  const expiresAtNum = typeof expires_at === 'number' ? expires_at : 0;

  try {
    await simulateCall('grant_verifier_consent', [
      addressVal(holder),
      addressVal(String(verifier)),
      u64Val(credentialId),
      u64Val(expiresAtNum),
    ]);

    res.status(201).json({
      credential_id: credentialId,
      holder,
      verifier,
      expires_at: expiresAtNum,
      granted: true,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('CredentialNotFound')) {
      res.status(404).json({ error: 'Credential not found' });
    } else if (msg.includes('UnauthorizedAction')) {
      res.status(403).json({ error: 'Only the credential holder may grant consent' });
    } else if (msg.includes('InvalidInput')) {
      res.status(400).json({ error: 'expires_at must be in the future' });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/credentials/:id/consent/grants/:verifier
//
// Body: { holder: string }
// ---------------------------------------------------------------------------
router.delete('/:id/consent/grants/:verifier', async (req: Request, res: Response) => {
  const credentialId = resolveCredentialId(req, res);
  if (credentialId === null) return;

  const { verifier } = req.params;
  const { holder } = req.body as { holder?: unknown };

  if (typeof holder !== 'string' || holder.length === 0) {
    res.status(400).json({ error: 'holder (Stellar address) is required in request body' });
    return;
  }

  try {
    await simulateCall('revoke_verifier_consent', [
      addressVal(holder),
      addressVal(String(verifier)),
      u64Val(credentialId),
    ]);

    res.json({
      credential_id: credentialId,
      verifier,
      revoked: true,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('CredentialNotFound')) {
      res.status(404).json({ error: 'Credential not found' });
    } else if (msg.includes('UnauthorizedAction')) {
      res.status(403).json({ error: 'Only the credential holder may revoke consent' });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/credentials/:id/consent/grants/:verifier
// ---------------------------------------------------------------------------
router.get('/:id/consent/grants/:verifier', async (req: Request, res: Response) => {
  const credentialId = resolveCredentialId(req, res);
  if (credentialId === null) return;

  const { verifier } = req.params;

  try {
    const grant = await simulateCall('get_verifier_consent', [
      u64Val(credentialId),
      addressVal(String(verifier)),
    ]);

    if (grant === null || grant === undefined) {
      res.status(404).json({ error: 'No consent grant found for this verifier' });
      return;
    }

    res.json(serializeBigInt(grant));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /api/credentials/:id/consent/grants/:verifier/status
// ---------------------------------------------------------------------------
router.get('/:id/consent/grants/:verifier/status', async (req: Request, res: Response) => {
  const credentialId = resolveCredentialId(req, res);
  if (credentialId === null) return;

  const { verifier } = req.params;

  try {
    const active = await simulateCall('has_verifier_consent', [
      u64Val(credentialId),
      addressVal(String(verifier)),
    ]);

    res.json({
      credential_id: credentialId,
      verifier,
      consent_active: Boolean(active),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /api/credentials/:id/consent/access
//
// Record an access event (for use by internal services / bridge relay).
//
// Body:
//   holder      string  credential subject (required)
//   verifier    string  verifier address   (required)
//   access_type number  1=share_link | 2=delegation | 3=proof_request (required)
// ---------------------------------------------------------------------------
router.post('/:id/consent/access', async (req: Request, res: Response) => {
  const credentialId = resolveCredentialId(req, res);
  if (credentialId === null) return;

  const { holder, verifier, access_type } = req.body as {
    holder?: unknown;
    verifier?: unknown;
    access_type?: unknown;
  };

  if (typeof holder !== 'string' || holder.length === 0) {
    res.status(400).json({ error: 'holder (Stellar address) is required' });
    return;
  }
  if (typeof verifier !== 'string' || verifier.length === 0) {
    res.status(400).json({ error: 'verifier (Stellar address) is required' });
    return;
  }
  const accessTypeNum = typeof access_type === 'number' ? access_type : parseInt(String(access_type ?? ''), 10);
  if (![1, 2, 3].includes(accessTypeNum)) {
    res.status(400).json({ error: 'access_type must be 1 (share_link), 2 (delegation), or 3 (proof_request)' });
    return;
  }

  try {
    await simulateCall('record_verifier_access', [
      addressVal(holder),
      u64Val(credentialId),
      addressVal(String(verifier)),
      u32Val(accessTypeNum),
    ]);

    res.status(201).json({
      credential_id: credentialId,
      verifier,
      access_type: accessTypeNum,
      access_type_label: ACCESS_TYPE_LABELS[accessTypeNum],
      recorded: true,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('CredentialNotFound')) {
      res.status(404).json({ error: 'Credential not found' });
    } else if (msg.includes('UnauthorizedAction')) {
      res.status(403).json({ error: 'Only the credential holder may record access events' });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

export default router;
