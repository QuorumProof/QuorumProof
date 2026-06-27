/**
 * Issue #877 — Share Link Expiration & Access Control
 *
 * Routes:
 *   POST   /api/credentials/:id/share          — create a share link
 *   POST   /api/credentials/share/validate     — redeem / validate a token
 *   DELETE /api/credentials/share/:token       — revoke a link (holder only)
 *   GET    /api/credentials/share/:token       — inspect link metadata
 */
import { Router, Request, Response } from 'express';
import { createHmac } from 'crypto';
import type { SorobanClient } from './credentials.js';
import { simulateCall, u64Val, u32Val, addressVal } from '../soroban.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a hex password to a 32-byte Soroban-compatible Bytes value. */
function buildPasswordHashArg(soroban: SorobanClient, rawPassword: string) {
  // We accept either a pre-computed 64-char hex SHA-256 or a plain password
  // that we hash here before sending on-chain (the contract stores the hash,
  // never the plaintext).
  const isHex64 = /^[0-9a-fA-F]{64}$/.test(rawPassword);
  const hexDigest = isHex64
    ? rawPassword
    : createHmac('sha256', process.env.SHARE_LINK_HMAC_SECRET ?? 'quorumproof')
        .update(rawPassword)
        .digest('hex');
  // Convert hex string to a bytes buffer for nativeToScVal
  const buf = Buffer.from(hexDigest, 'hex'); // 32 bytes
  return { hexDigest, buf };
}

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

// Permission mapping for documentation
const PERMISSION_LABELS: Record<number, string> = {
  1: 'view_only',
  2: 'download',
};

// ---------------------------------------------------------------------------
// Router factory (injectable soroban client for testing)
// ---------------------------------------------------------------------------

export function createShareLinksRouter(soroban: SorobanClient) {
  const router = Router({ mergeParams: true });

  /**
   * POST /api/credentials/:id/share
   *
   * Body:
   *   expiry_hours  number   1–8760         required
   *   permission    string   "view_only" | "download"  required
   *   password      string?  plain-text password; omit for public links
   *
   * Returns: { token: string (hex), expires_at: number, permission: string }
   */
  router.post('/:id/share', async (req: Request, res: Response) => {
    const credentialId = parseInt(req.params.id, 10);
    if (!Number.isInteger(credentialId) || credentialId <= 0) {
      res.status(400).json({ error: 'Invalid credential ID' });
      return;
    }

    const { expiry_hours, permission, password, subject } = req.body as {
      expiry_hours?: unknown;
      permission?: unknown;
      password?: unknown;
      subject?: unknown;
    };

    if (typeof subject !== 'string' || subject.length === 0) {
      res.status(400).json({ error: 'subject (Stellar address) is required' });
      return;
    }

    const expiryHours = typeof expiry_hours === 'number' ? expiry_hours : parseInt(String(expiry_hours ?? ''), 10);
    if (!Number.isInteger(expiryHours) || expiryHours < 1 || expiryHours > 8760) {
      res.status(400).json({ error: 'expiry_hours must be an integer between 1 and 8760' });
      return;
    }

    const permissionMap: Record<string, number> = { view_only: 1, download: 2 };
    const permissionStr = typeof permission === 'string' ? permission : '';
    const permissionCode = permissionMap[permissionStr];
    if (!permissionCode) {
      res.status(400).json({ error: 'permission must be "view_only" or "download"' });
      return;
    }

    // Build optional password hash argument
    let passwordHashArg: ReturnType<typeof soroban.u64Val> | null = null;
    let passwordHashHex: string | null = null;

    if (typeof password === 'string' && password.length > 0) {
      const { hexDigest, buf } = buildPasswordHashArg(soroban, password);
      passwordHashHex = hexDigest;
      // Pass as { type: 'bytes', value: buf } via nativeToScVal
      const { nativeToScVal } = await import('@stellar/stellar-sdk');
      passwordHashArg = nativeToScVal(buf, { type: 'bytes' }) as ReturnType<typeof soroban.u64Val>;
    }

    try {
      // Call contract: generate_share_link(subject, credential_id, expiry_hours, password_hash, permission)
      const { nativeToScVal } = await import('@stellar/stellar-sdk');
      const args = [
        addressVal(subject),
        soroban.u64Val(credentialId),
        soroban.u32Val(expiryHours),
        passwordHashArg ?? nativeToScVal(null, { type: 'void' }),
        soroban.u32Val(permissionCode),
      ];

      const tokenBytes = await simulateCall('generate_share_link', args);
      const tokenHex = Buffer.from(tokenBytes as Uint8Array).toString('hex');

      // Decode expires_at from the token (bytes 8–16)
      const rawBuf = Buffer.from(tokenBytes as Uint8Array);
      const expiresAt = rawBuf.readBigUInt64BE(8);

      res.status(201).json({
        token: tokenHex,
        expires_at: Number(expiresAt),
        permission: PERMISSION_LABELS[permissionCode],
        password_protected: passwordHashHex !== null,
        credential_id: credentialId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('CredentialNotFound')) {
        res.status(404).json({ error: 'Credential not found' });
      } else if (msg.includes('UnauthorizedAction')) {
        res.status(403).json({ error: 'Only the credential holder can create share links' });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  /**
   * POST /api/credentials/share/validate
   *
   * Body:
   *   token     string (hex)  required
   *   password  string?       plain text (only for password-protected links)
   *
   * Returns: { credential_id, permission, expires_at, created_by }
   */
  router.post('/share/validate', async (req: Request, res: Response) => {
    const { token, password } = req.body as { token?: unknown; password?: unknown };

    if (typeof token !== 'string' || token.length === 0) {
      res.status(400).json({ error: 'token is required' });
      return;
    }

    let tokenBuf: Buffer;
    try {
      tokenBuf = Buffer.from(token, 'hex');
      if (tokenBuf.length !== 16) throw new Error('bad length');
    } catch {
      res.status(400).json({ error: 'token must be a 16-byte hex string (32 hex characters)' });
      return;
    }

    const { nativeToScVal } = await import('@stellar/stellar-sdk');
    let passwordHashArg = nativeToScVal(null, { type: 'void' });

    if (typeof password === 'string' && password.length > 0) {
      const { buf } = buildPasswordHashArg(
        soroban,
        password
      );
      passwordHashArg = nativeToScVal(buf, { type: 'bytes' });
    }

    try {
      const tokenScVal = nativeToScVal(tokenBuf, { type: 'bytes' });
      const link = await simulateCall('validate_share_token', [tokenScVal, passwordHashArg]);
      res.json(serializeBigInt(link));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('InvalidInput')) {
        res.status(410).json({ error: 'Share link is expired, revoked, or invalid' });
      } else if (msg.includes('PermissionDenied')) {
        res.status(403).json({ error: 'Invalid or missing password for this share link' });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  /**
   * DELETE /api/credentials/share/:token
   *
   * Body: { subject: string }
   * Revokes the link early. Only the creator can revoke.
   */
  router.delete('/share/:token', async (req: Request, res: Response) => {
    const { token } = req.params;
    const { subject } = req.body as { subject?: unknown };

    if (typeof subject !== 'string' || subject.length === 0) {
      res.status(400).json({ error: 'subject (Stellar address) is required' });
      return;
    }

    let tokenBuf: Buffer;
    try {
      tokenBuf = Buffer.from(token, 'hex');
      if (tokenBuf.length !== 16) throw new Error('bad length');
    } catch {
      res.status(400).json({ error: 'token must be a 16-byte hex string' });
      return;
    }

    try {
      const { nativeToScVal } = await import('@stellar/stellar-sdk');
      const tokenScVal = nativeToScVal(tokenBuf, { type: 'bytes' });
      await simulateCall('revoke_share_link', [addressVal(subject), tokenScVal]);
      res.json({ success: true, message: 'Share link revoked' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('InvalidInput')) {
        res.status(404).json({ error: 'Share link not found' });
      } else if (msg.includes('UnauthorizedAction')) {
        res.status(403).json({ error: 'Only the link creator can revoke it' });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  /**
   * GET /api/credentials/share/:token
   *
   * Returns the raw ShareLink metadata (no access enforcement — for admin/holder inspection).
   */
  router.get('/share/:token', async (req: Request, res: Response) => {
    const { token } = req.params;

    let tokenBuf: Buffer;
    try {
      tokenBuf = Buffer.from(token, 'hex');
      if (tokenBuf.length !== 16) throw new Error('bad length');
    } catch {
      res.status(400).json({ error: 'token must be a 16-byte hex string' });
      return;
    }

    try {
      const { nativeToScVal } = await import('@stellar/stellar-sdk');
      const tokenScVal = nativeToScVal(tokenBuf, { type: 'bytes' });
      const link = await simulateCall('get_share_link', [tokenScVal]);
      if (link === null || link === undefined) {
        res.status(404).json({ error: 'Share link not found' });
        return;
      }
      // Redact password_hash from the public response
      const result = serializeBigInt(link) as Record<string, unknown>;
      if (result.password_hash !== null && result.password_hash !== undefined) {
        result.password_protected = true;
        delete result.password_hash;
      } else {
        result.password_protected = false;
      }
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

// Default export wired to the real Soroban client
export default createShareLinksRouter({
  simulateCall,
  u64Val: u64Val as SorobanClient['u64Val'],
  u32Val: u32Val as SorobanClient['u32Val'],
  addressVal: addressVal as SorobanClient['addressVal'],
});
