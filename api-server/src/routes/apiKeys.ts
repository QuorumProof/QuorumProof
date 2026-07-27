/**
 * API Key Management Routes — Issue #999
 * Endpoints for self-service key rotation and management.
 */

import { Router, Request, Response } from 'express';
import { getDefaultApiKeyManager, type ApiKeySecret } from '../services/apiKeyManager.js';

const router = Router();

// Middleware: Extract issuer from request (from auth header or claim)
function getIssuerFromRequest(req: Request): string | undefined {
  // In a real implementation, this would extract from JWT or API key auth
  // For now, we use a header or fallback to a test value
  return req.headers['x-issuer'] as string | undefined || req.headers['authorization']?.replace('Bearer ', '').slice(0, 16);
}

// POST /api/api-keys — Generate a new API key
router.post('/', (req: Request, res: Response) => {
  const issuer = getIssuerFromRequest(req);
  if (!issuer) {
    res.status(401).json({ error: 'Missing or invalid authorization' });
    return;
  }

  const { name } = req.body as { name?: unknown };

  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required and must be a non-empty string' });
    return;
  }

  try {
    const manager = getDefaultApiKeyManager();
    const keySecret = manager.generateKey(issuer, name);

    // Return with explicit warning that the key is only shown once
    res.status(201).json({
      ...keySecret,
      warning: 'Store this key securely. It will not be shown again.',
    } as ApiKeySecret & { warning: string });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to generate key' });
  }
});

// GET /api/api-keys — List all active API keys for the issuer
router.get('/', (req: Request, res: Response) => {
  const issuer = getIssuerFromRequest(req);
  if (!issuer) {
    res.status(401).json({ error: 'Missing or invalid authorization' });
    return;
  }

  try {
    const manager = getDefaultApiKeyManager();
    const keys = manager.listKeys(issuer);

    // Return keys without the hash (for security)
    const safeKeys = keys.map(k => ({
      id: k.id,
      name: k.name,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      active: k.active,
    }));

    res.json({ data: safeKeys });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to list keys' });
  }
});

// GET /api/api-keys/:id — Get a specific API key
router.get('/:id', (req: Request, res: Response) => {
  const issuer = getIssuerFromRequest(req);
  if (!issuer) {
    res.status(401).json({ error: 'Missing or invalid authorization' });
    return;
  }

  try {
    const manager = getDefaultApiKeyManager();
    const key = manager.getKey(req.params.id as string);

    if (!key || key.issuer !== issuer) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    // Return key without the hash
    res.json({
      id: key.id,
      name: key.name,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      active: key.active,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to get key' });
  }
});

// DELETE /api/api-keys/:id — Revoke an API key
router.delete('/:id', (req: Request, res: Response) => {
  const issuer = getIssuerFromRequest(req);
  if (!issuer) {
    res.status(401).json({ error: 'Missing or invalid authorization' });
    return;
  }

  try {
    const manager = getDefaultApiKeyManager();
    const key = manager.getKey(req.params.id as string);

    if (!key || key.issuer !== issuer) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    manager.revokeKey(req.params.id as string);
    res.status(204).end();
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to revoke key' });
  }
});

// POST /api/api-keys/:id/rotate — Rotate a key; old key keeps working for a grace period
router.post('/:id/rotate', (req: Request, res: Response) => {
  const issuer = getIssuerFromRequest(req);
  if (!issuer) {
    res.status(401).json({ error: 'Missing or invalid authorization' });
    return;
  }

  try {
    const manager = getDefaultApiKeyManager();
    const key = manager.getKey(req.params.id as string);

    if (!key || key.issuer !== issuer) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    const { gracePeriodMs } = req.body as { gracePeriodMs?: unknown };
    const grace = typeof gracePeriodMs === 'number' && gracePeriodMs > 0 ? gracePeriodMs : undefined;

    const newSecret = manager.rotateKey(req.params.id as string, grace);
    if (!newSecret) {
      res.status(409).json({ error: 'Key is already inactive and cannot be rotated' });
      return;
    }

    res.status(201).json({
      ...newSecret,
      rotatedFrom: req.params.id,
      warning: 'Store this key securely. It will not be shown again. The old key remains valid until its grace period expires.',
    });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to rotate key' });
  }
});

// GET /api/api-keys/:id/usage — Get usage history for a key
router.get('/:id/usage', (req: Request, res: Response) => {
  const issuer = getIssuerFromRequest(req);
  if (!issuer) {
    res.status(401).json({ error: 'Missing or invalid authorization' });
    return;
  }

  try {
    const manager = getDefaultApiKeyManager();
    const key = manager.getKey(req.params.id as string);

    if (!key || key.issuer !== issuer) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const usage = manager.getUsageHistory(req.params.id as string, limit);

    res.json({ data: usage });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to get usage history' });
  }
});

// GET /api/api-keys/stats — Get issuer's key statistics
router.get('/stats/overview', (req: Request, res: Response) => {
  const issuer = getIssuerFromRequest(req);
  if (!issuer) {
    res.status(401).json({ error: 'Missing or invalid authorization' });
    return;
  }

  try {
    const manager = getDefaultApiKeyManager();
    const stats = manager.getKeyStats(issuer);
    res.json(stats);
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to get key statistics' });
  }
});

export default router;
