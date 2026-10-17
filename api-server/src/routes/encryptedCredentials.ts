import { Router, Request, Response } from 'express';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { ThresholdEncryption, type EncryptedData, type ThresholdKeyShare } from '../crypto/thresholdEncryption.js';
import { EncryptedCredentialStore } from '../services/encryptedCredentialStore.js';
import { rbac } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import * as soroban from '../soroban.js';

const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

export function buildDecryptionAuthorizationMessage(
  credentialId: string,
  requesterAddress: string,
  reason: string,
  timestamp: number,
  nonce: string,
): string {
  return [
    'QuorumProof Decryption Authorization',
    `credential:${credentialId}`,
    `requester:${requesterAddress}`,
    `reason:${reason}`,
    `timestamp:${timestamp}`,
    `nonce:${nonce}`,
  ].join('\n');
}

export function buildDecryptionRequestMessage(
  credentialId: string,
  requesterAddress: string,
  timestamp: number,
  nonce: string,
): string {
  return [
    'QuorumProof Decryption Request',
    `credential:${credentialId}`,
    `requester:${requesterAddress}`,
    `timestamp:${timestamp}`,
    `nonce:${nonce}`,
  ].join('\n');
}

function verifyStellarSignature(address: string, message: string, signature: string): boolean {
  if (!StrKey.isValidEd25519PublicKey(address)) return false;
  try {
    const signatureBytes = Buffer.from(signature, 'base64');
    if (!isValidSignatureEncoding(signature) || signatureBytes.length !== 64) return false;
    return Keypair.fromPublicKey(address).verify(Buffer.from(message, 'utf8'), signatureBytes);
  } catch {
    return false;
  }
}

function isValidSignatureEncoding(signature: string): boolean {
  const signatureBytes = Buffer.from(signature, 'base64');
  return signatureBytes.length === 64 && signatureBytes.toString('base64') === signature;
}

function isValidAddress(value: unknown): value is string {
  return typeof value === 'string' && StrKey.isValidEd25519PublicKey(value);
}

function isValidBase64Bytes32(value: string): boolean {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

function isRecentTimestamp(timestamp: number): boolean {
  return Number.isSafeInteger(timestamp) && Math.abs(Date.now() - timestamp) <= SIGNATURE_MAX_AGE_MS;
}

/**
 * Encrypted Credentials Routes
 * Issue #1572: Implement Threshold Encryption for Sensitive Data
 *
 * Endpoints:
 * POST /api/credentials/:id/encrypt - Encrypt sensitive fields
 * GET /api/credentials/:id/encrypted - Get encrypted credential data
 * POST /api/credentials/:id/decrypt/authorize - Request decryption authorization
 * POST /api/credentials/:id/decrypt - Decrypt with authorization
 * GET /api/credentials/:id/decrypt/status - Check decryption authorization status
 */

export function createEncryptedCredentialsRouter(
  dependencies: {
    store?: EncryptedCredentialStore;
    encryption?: ThresholdEncryption;
    simulateCall?: typeof soroban.simulateCall;
  } = {},
) {
  const router = Router();
  const store = dependencies.store ?? new EncryptedCredentialStore();
  const encryption = dependencies.encryption ?? new ThresholdEncryption(3, 5); // 3-of-5 threshold encryption
  const simulateCall = dependencies.simulateCall ?? soroban.simulateCall;
  const threshold = encryption.getConfig().threshold;
  const sharesCount = encryption.getConfig().shares;
  const keyShareSchema = {
    type: 'object',
    properties: {
      share_id: { type: 'integer', minimum: 1, maximum: sharesCount },
      share_value: { type: 'string', minLength: 44, maxLength: 44 },
      commitment: { type: 'string', minLength: 44, maxLength: 44 },
    },
    required: ['share_id', 'share_value', 'commitment'],
    additionalProperties: false,
  };

  // POST /api/credentials/:id/encrypt
  // Encrypt sensitive fields of a credential
  router.post(
    '/:id/encrypt',
    validate({
      body: {
        schema: {
          type: 'object',
          properties: {
            sensitive_fields: { type: 'object' },
            keyCustodians: {
              type: 'array',
              minItems: threshold,
              maxItems: sharesCount,
              items: { type: 'string' },
            },
          },
          required: ['sensitive_fields', 'keyCustodians'],
          additionalProperties: false,
        },
        custom: (body) => {
          if (typeof body !== 'object' || body === null) return 'Request body must be an object';
          const custodians = (body as { keyCustodians?: unknown }).keyCustodians;
          if (!Array.isArray(custodians) || !custodians.every(isValidAddress)) {
            return 'keyCustodians must contain valid Stellar G-addresses';
          }
          if (new Set(custodians).size !== custodians.length) {
            return 'keyCustodians must not contain duplicates';
          }
          return true;
        },
      },
    }),
    async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id;
    const { sensitive_fields, keyCustodians } = req.body as {
      sensitive_fields?: Record<string, unknown>;
      keyCustodians?: string[];
    };

    if (!sensitive_fields || typeof sensitive_fields !== 'object') {
      res.status(400).json({
        error: 'Invalid request',
        message: 'sensitive_fields is required and must be an object',
        },
      );
      return;
    }

    if (!keyCustodians || !Array.isArray(keyCustodians) || keyCustodians.length < encryption.getConfig().threshold) {
      res.status(400).json({
        error: 'Invalid key custodians',
        message: `At least ${encryption.getConfig().threshold} key custodians are required`,
      });
      return;
    }

    try {
      const credentialId = BigInt(id);
      const { encrypted, keyShares } = encryption.encryptSensitiveData(
        JSON.stringify(sensitive_fields)
      );

      // Store encrypted data
      await store.storeEncryptedCredential(credentialId, encrypted, keyShares, keyCustodians);

      res.json({
        success: true,
        message: 'Sensitive fields encrypted successfully',
        credential_id: id,
        encryption_info: {
          threshold: encryption.getConfig().threshold,
          shares_count: encryption.getConfig().shares,
          key_custodians: keyCustodians,
          share_metadata: encrypted.share_metadata,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: 'Encryption failed',
        message,
      });
    }
  });

  // GET /api/credentials/:id/encrypted
  // Get encrypted credential data (metadata only, no key shares)
  router.get('/:id/encrypted', async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id;

    try {
      const credentialId = BigInt(id);
      const encrypted = await store.getEncryptedCredential(credentialId);

      if (!encrypted) {
        res.status(404).json({
          error: 'Not found',
          message: 'No encrypted data found for this credential',
        });
        return;
      }

      res.json({
        credential_id: id,
        encryption_info: {
          threshold: encrypted.encrypted_data.threshold,
          shares_count: encrypted.encrypted_data.shares_count,
          key_custodians: encrypted.key_custodians,
          share_metadata: encrypted.encrypted_data.share_metadata,
        },
        created_at: new Date(encrypted.created_at).toISOString(),
        updated_at: new Date(encrypted.updated_at).toISOString(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: 'Failed to retrieve encrypted data',
        message,
      });
    }
  });

  // POST /api/credentials/:id/decrypt/authorize
  // Request decryption authorization
  router.post(
    '/:id/decrypt/authorize',
    validate({
      body: {
        schema: {
          type: 'object',
          properties: {
            requester_address: { type: 'string' },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
            timestamp: { type: 'integer', minimum: 0 },
            nonce: { type: 'string', pattern: '^[a-fA-F0-9]{32,128}$' },
            signature: { type: 'string', minLength: 88, maxLength: 88 },
            approvals: {
              type: 'array',
              minItems: threshold,
              maxItems: sharesCount,
              items: {
                type: 'object',
                properties: {
                  address: { type: 'string' },
                  signature: { type: 'string', minLength: 88, maxLength: 88 },
                },
                required: ['address', 'signature'],
                additionalProperties: false,
              },
            },
          },
          required: ['requester_address', 'reason', 'timestamp', 'nonce', 'signature', 'approvals'],
          additionalProperties: false,
        },
        custom: (body) => {
          if (typeof body !== 'object' || body === null) return 'Request body must be an object';
          const values = body as {
            requester_address?: unknown;
            signature?: unknown;
            approvals?: Array<{ address: string; signature: string }>;
          };
          if (!isValidAddress(values.requester_address)) {
            return 'requester_address must be a valid Stellar G-address';
          }
          if (typeof values.signature !== 'string' || !isValidSignatureEncoding(values.signature)) {
            return 'signature must be a valid 64-byte base64 Stellar signature';
          }
          const approvals = values.approvals;
          if (!Array.isArray(approvals) || !approvals.every((approval) =>
            isValidAddress(approval.address) && isValidSignatureEncoding(approval.signature)
          )) {
            return 'approvals must contain valid Stellar addresses and signatures';
          }
          if (new Set(approvals.map((approval) => approval.address)).size !== approvals.length) {
            return 'approvals must not contain duplicate custodians';
          }
          return true;
        },
      },
    }),
    async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id;
    const { requester_address, reason, timestamp, nonce, signature, approvals } = req.body as {
      requester_address?: string;
      reason?: string;
      timestamp?: number;
      nonce?: string;
      signature?: string;
      approvals?: Array<{ address: string; signature: string }>;
    };

    if (
      typeof requester_address !== 'string' ||
      typeof reason !== 'string' ||
      typeof timestamp !== 'number' ||
      typeof nonce !== 'string' ||
      typeof signature !== 'string' ||
      !Array.isArray(approvals)
    ) {
      res.status(400).json({
        error: 'Invalid request',
        message: 'requester_address, reason, timestamp, nonce, signature, and custodian approvals are required',
        },
      );
      return;
    }

    const authorizationMessage = buildDecryptionAuthorizationMessage(
      id,
      requester_address,
      reason,
      timestamp,
      nonce,
    );
    if (
      !isRecentTimestamp(timestamp) ||
      !/^[a-f0-9]{32,128}$/i.test(nonce) ||
      !verifyStellarSignature(requester_address, authorizationMessage, signature)
    ) {
      res.status(401).json({ error: 'Invalid requester signature or expired challenge' });
      return;
    }

    try {
      const credentialId = BigInt(id);
      const credential = await simulateCall('get_credential', [soroban.u64Val(credentialId)]);
      const credentialRecord = credential as { subject?: unknown; issuer?: unknown };
      if (requester_address !== credentialRecord.subject && requester_address !== credentialRecord.issuer) {
        res.status(403).json({ error: 'Only the credential holder or issuer may request decryption' });
        return;
      }

      const custodians = await store.getKeyCustodians(credentialId);
      const threshold = encryption.getConfig().threshold;
      const verifiedApprovers = new Set<string>();
      for (const approval of approvals) {
        if (
          custodians.includes(approval.address) &&
          !verifiedApprovers.has(approval.address) &&
          verifyStellarSignature(approval.address, authorizationMessage, approval.signature)
        ) {
          verifiedApprovers.add(approval.address);
        }
      }
      if (verifiedApprovers.size < threshold) {
        res.status(403).json({
          error: 'Insufficient custodian approvals',
          message: `At least ${threshold} configured key custodians must approve`,
        });
        return;
      }

      const authorization = await store.authorizeDecryption(
        credentialId,
        requester_address,
        3600000,
        reason,
        [...verifiedApprovers]
      );

      res.json({
        success: true,
        message: 'Decryption authorization granted',
        credential_id: id,
        authorized_address: requester_address,
        expires_at: new Date(authorization.expires_at).toISOString(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: 'Authorization failed',
        message,
      });
    }
  });

  // POST /api/credentials/:id/decrypt
  // Decrypt with key shares (requires authorization)
  router.post(
    '/:id/decrypt',
    validate({
      body: {
        schema: {
          type: 'object',
          properties: {
            requester_address: { type: 'string' },
            key_shares: {
              type: 'array',
              minItems: threshold,
              maxItems: sharesCount,
              items: keyShareSchema,
            },
            timestamp: { type: 'integer', minimum: 0 },
            nonce: { type: 'string', pattern: '^[a-fA-F0-9]{32,128}$' },
            signature: { type: 'string', minLength: 88, maxLength: 88 },
          },
          required: ['requester_address', 'key_shares', 'timestamp', 'nonce', 'signature'],
          additionalProperties: false,
        },
        custom: (body) => {
          if (typeof body !== 'object' || body === null) return 'Request body must be an object';
          const values = body as {
            requester_address?: unknown;
            signature?: unknown;
            key_shares?: ThresholdKeyShare[];
          };
          if (!isValidAddress(values.requester_address)) {
            return 'requester_address must be a valid Stellar G-address';
          }
          if (typeof values.signature !== 'string' || !isValidSignatureEncoding(values.signature)) {
            return 'signature must be a valid 64-byte base64 Stellar signature';
          }
          const keyShares = values.key_shares;
          if (!Array.isArray(keyShares)) return 'key_shares must be an array';
          if (new Set(keyShares.map((share) => share.share_id)).size !== keyShares.length) {
            return 'key_shares must not contain duplicate share_id values';
          }
          if (!keyShares.every((share) =>
            isValidBase64Bytes32(share.share_value) && isValidBase64Bytes32(share.commitment)
          )) {
            return 'key_shares must contain 32-byte base64 share values and commitments';
          }
          return true;
        },
      },
    }),
    async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id;
    const { requester_address, key_shares, timestamp, nonce, signature } = req.body as {
      requester_address?: string;
      key_shares?: ThresholdKeyShare[];
      timestamp?: number;
      nonce?: string;
      signature?: string;
    };

    if (
      typeof requester_address !== 'string' ||
      !Array.isArray(key_shares) ||
      typeof timestamp !== 'number' ||
      typeof nonce !== 'string' ||
      typeof signature !== 'string'
    ) {
      res.status(400).json({
        error: 'Invalid request',
        message: 'requester_address, key_shares, timestamp, nonce, and signature are required',
      });
      return;
    }

    const requestMessage = buildDecryptionRequestMessage(id, requester_address, timestamp, nonce);
    if (
      !isRecentTimestamp(timestamp) ||
      !/^[a-f0-9]{32,128}$/i.test(nonce) ||
      !verifyStellarSignature(requester_address, requestMessage, signature)
    ) {
      res.status(401).json({ error: 'Invalid requester signature or expired challenge' });
      return;
    }

    try {
      const credentialId = BigInt(id);

      // Check authorization
      const isAuthorized = await store.isDecryptionAuthorized(credentialId, requester_address);
      if (!isAuthorized) {
        res.status(403).json({
          error: 'Not authorized',
          message: 'Decryption authorization not found or expired',
        });
        return;
      }

      // Get encrypted data
      const encrypted = await store.getEncryptedCredential(credentialId);
      if (!encrypted) {
        res.status(404).json({
          error: 'Not found',
          message: 'No encrypted data found for this credential',
        });
        return;
      }

      // Decrypt
      try {
        const shareMetadata = encrypted.encrypted_data.share_metadata;
        const validShares = key_shares.every((share) => {
          const metadata = shareMetadata.find((item) => item.share_id === share.share_id);
          return metadata !== undefined &&
            metadata.commitment === share.commitment &&
            encryption.verifyShare(share, metadata.commitment);
        });
        if (!validShares) {
          throw new Error('One or more key shares are invalid');
        }

        const decrypted = encryption.decryptSensitiveData(encrypted.encrypted_data, key_shares);
        const decryptedData = JSON.parse(decrypted.toString());

        await store.logDecryptionAttempt(credentialId, requester_address, true, {
          verified_identity: requester_address,
          shared_count: key_shares.length,
          },
        );

        res.json({
          success: true,
          message: 'Decryption successful',
          credential_id: id,
          decrypted_data: decryptedData,
          decrypted_at: new Date().toISOString(),
        });
      } catch (decryptErr: unknown) {
        // Log failed decryption
        await store.logDecryptionAttempt(credentialId, requester_address, false, {
          verified_identity: requester_address,
          error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
          share_count: key_shares.length,
        });

        res.status(400).json({
          error: 'Decryption failed',
          message: decryptErr instanceof Error ? decryptErr.message : 'Invalid key shares or data corruption',
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: 'Decryption request failed',
        message,
      });
    }
  });

  // GET /api/credentials/:id/decrypt/status
  // Check decryption authorization status
  router.get('/:id/decrypt/status', async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id;
    const { requester_address } = req.query as { requester_address?: string };

    if (!requester_address) {
      res.status(400).json({
        error: 'Invalid request',
        message: 'requester_address query parameter is required',
      });
      return;
    }

    try {
      const credentialId = BigInt(id);

      const isAuthorized = await store.isDecryptionAuthorized(credentialId, requester_address as string);
      const authorizations = await store.getActiveAuthorizations(credentialId);

      res.json({
        credential_id: id,
        requester_address,
        authorized: isAuthorized,
        active_authorizations: authorizations
          .filter((a) => a.requester_address === requester_address)
          .map((a) => ({
            authorized_at: new Date(a.authorized_at).toISOString(),
            expires_at: new Date(a.expires_at).toISOString(),
            reason: a.reason,
          }))[0] || null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: 'Failed to get authorization status',
        message,
      });
    }
  });

  // GET /api/credentials/:id/decrypt/audit
  // Get decryption audit log (admin only)
  router.get('/:id/decrypt/audit', rbac.requirePermission('admin:all'), async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id;

    try {
      const credentialId = BigInt(id);
      const authorizations = await store.getActiveAuthorizations(credentialId);

      res.json({
        credential_id: id,
        active_authorizations: authorizations.map((a) => ({
          requester_address: a.requester_address,
          authorized_at: new Date(a.authorized_at).toISOString(),
          expires_at: new Date(a.expires_at).toISOString(),
          reason: a.reason,
          approved_by: a.approved_by,
        })),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: 'Failed to get audit log',
        message,
      });
    }
  });

  return router;
}

export default createEncryptedCredentialsRouter();
