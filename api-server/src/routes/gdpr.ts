import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';
import {
  PersonalDataVault,
  KeyDestroyedError,
  PersonalDataNotFoundError,
  getDefaultVault,
} from '../services/cryptoShredding.js';
import { GdprRequestStore, GdprRequest, getDefaultRequestStore } from '../services/gdprRequestStore.js';
import { verifyAttestorConsentSignature } from '../services/attestorConsent.js';

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => any;
};

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

function parseCredentialId(raw: unknown): number | null {
  const id = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

async function fetchCredentialSubject(
  soroban: SorobanClient,
  credentialId: number
): Promise<{ subject: string } | null> {
  try {
    const credential = await soroban.simulateCall('get_credential', [soroban.u64Val(credentialId)]);
    const subject =
      credential && typeof credential === 'object' && 'subject' in (credential as Record<string, unknown>)
        ? String((credential as Record<string, unknown>).subject)
        : undefined;
    if (!subject) return null;
    return { subject };
  } catch {
    return null;
  }
}

async function fetchAttestors(soroban: SorobanClient, credentialId: number): Promise<string[]> {
  const raw = await soroban.simulateCall('get_attestors', [soroban.u64Val(credentialId)]);
  return Array.isArray(raw) ? raw.map((a) => String(a)) : [];
}

export interface GdprRouterOptions {
  vault?: PersonalDataVault;
  requestStore?: GdprRequestStore;
}

export function createGdprRouter(soroban: SorobanClient, options: GdprRouterOptions = {}) {
  const router = Router();
  // Resolved lazily inside each handler (not once at router-construction
  // time) so that merely importing this module — or constructing a router
  // with explicit test doubles via `options` — never has the side effect of
  // creating the default on-disk data directories. They're only touched on
  // the first request that actually needs them.
  const getVault = () => options.vault ?? getDefaultVault();
  const getRequestStore = () => options.requestStore ?? getDefaultRequestStore();

  function withVaultStatus(vault: PersonalDataVault, gdprRequest: GdprRequest) {
    return { ...gdprRequest, vault: vault.status(gdprRequest.credentialId) };
  }

  // -------------------------------------------------------------------------
  // POST /api/gdpr/personal-data
  //
  // Stores a credential's personal data off-chain, encrypted with a
  // per-credential key. Returns a sha256 commitment of the plaintext —
  // callers (typically the issuer, at credential issuance time) should
  // anchor this commitment on-chain (e.g. as the credential's metadata_hash)
  // so integrity remains verifiable without any personal data ever touching
  // the ledger. See docs/crypto-shredding-architecture.md.
  //
  // Body: { credentialId: number, subject: string, personalData: unknown }
  // -------------------------------------------------------------------------
  router.post('/personal-data', async (req: Request, res: Response) => {
    const { credentialId: rawCredentialId, subject, personalData } = req.body as {
      credentialId?: unknown;
      subject?: unknown;
      personalData?: unknown;
    };

    const credentialId = parseCredentialId(rawCredentialId);
    if (credentialId === null) {
      res.status(400).json({ error: 'credentialId must be a positive integer' });
      return;
    }
    if (typeof subject !== 'string' || subject.trim() === '') {
      res.status(400).json({ error: 'subject (Stellar address) is required' });
      return;
    }
    if (personalData === undefined) {
      res.status(400).json({ error: 'personalData is required' });
      return;
    }

    const onChain = await fetchCredentialSubject(soroban, credentialId);
    if (!onChain) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }
    if (onChain.subject !== subject) {
      res.status(400).json({ error: 'subject does not match the on-chain credential subject' });
      return;
    }

    const vault = getVault();
    try {
      const { commitment } = vault.store(credentialId, subject, personalData);
      res.status(201).json({ credentialId, subject, commitment, status: vault.status(credentialId) });
    } catch (err: unknown) {
      if (err instanceof KeyDestroyedError) {
        res.status(410).json({ error: err.message });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/gdpr/personal-data/:credentialId/status
  //
  // Metadata only — never decrypts. Safe to expose without authorization,
  // since it reveals no personal data (only existence, timestamps, and the
  // commitment hash, all of which remain meaningful post-erasure).
  // -------------------------------------------------------------------------
  router.get('/personal-data/:credentialId/status', (req: Request, res: Response) => {
    const credentialId = parseCredentialId(req.params.credentialId);
    if (credentialId === null) {
      res.status(400).json({ error: 'credentialId must be a positive integer' });
      return;
    }
    res.json(getVault().status(credentialId));
  });

  // -------------------------------------------------------------------------
  // GET /api/gdpr/personal-data/:credentialId
  //
  // Decrypts and returns the stored personal data. NOTE: production
  // deployments must gate this behind the same holder/verifier authorization
  // used elsewhere (see routes/consent.ts) before exposing plaintext — this
  // route intentionally has no such check, matching the rest of this file's
  // scope (correctness of the erasure mechanism, not endpoint authorization).
  // -------------------------------------------------------------------------
  router.get('/personal-data/:credentialId', (req: Request, res: Response) => {
    const credentialId = parseCredentialId(req.params.credentialId);
    if (credentialId === null) {
      res.status(400).json({ error: 'credentialId must be a positive integer' });
      return;
    }

    const vault = getVault();
    try {
      const record = vault.retrieve(credentialId);
      res.json(record);
    } catch (err: unknown) {
      if (err instanceof KeyDestroyedError) {
        res.status(410).json({ error: err.message, erasedAt: vault.status(credentialId).erasedAt });
        return;
      }
      if (err instanceof PersonalDataNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/gdpr/request
  //
  // Submit a GDPR right-to-erasure request for a credential. If the
  // credential currently has no attestors, erasure completes immediately —
  // by genuinely destroying the credential's decryption key, not by flipping
  // a status flag. Otherwise the request waits for signed consent from every
  // current attestor (see POST /consent).
  //
  // Body: { credentialId: number }
  // -------------------------------------------------------------------------
  router.post('/request', async (req: Request, res: Response) => {
    const { credentialId: rawCredentialId } = req.body as { credentialId?: unknown };

    const credentialId = parseCredentialId(rawCredentialId);
    if (credentialId === null) {
      res.status(400).json({ error: 'credentialId must be a positive integer' });
      return;
    }

    const onChain = await fetchCredentialSubject(soroban, credentialId);
    if (!onChain) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }

    let attestors: string[];
    try {
      attestors = await fetchAttestors(soroban, credentialId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Could not determine attestor set: ${msg}` });
      return;
    }

    const vault = getVault();
    const requestStore = getRequestStore();

    const requestId = requestStore.nextRequestId();
    const gdprRequest: GdprRequest = {
      requestId,
      credentialId,
      subject: onChain.subject,
      requestedAt: new Date().toISOString(),
      status: attestors.length === 0 ? 'anonymized' : 'pending_consent',
      attestorConsents: [],
      requiredConsents: attestors.length,
      eligibleAttestors: attestors,
    };

    if (gdprRequest.status === 'anonymized') {
      const erasure = vault.eraseKey(credentialId);
      gdprRequest.erasedAt = erasure.erasedAt;
      gdprRequest.commitment = vault.status(credentialId).commitment;
    }

    requestStore.set(gdprRequest);

    res.status(201).json(serializeBigInt(withVaultStatus(vault, gdprRequest)));
  });

  // -------------------------------------------------------------------------
  // GET /api/gdpr/request/:requestId
  // -------------------------------------------------------------------------
  router.get('/request/:requestId', (req: Request, res: Response) => {
    const gdprRequest = getRequestStore().get(req.params.requestId);
    if (!gdprRequest) {
      res.status(404).json({ error: 'GDPR request not found' });
      return;
    }
    res.json(serializeBigInt(withVaultStatus(getVault(), gdprRequest)));
  });

  // -------------------------------------------------------------------------
  // POST /api/gdpr/consent
  //
  // An attestor consents to a pending GDPR erasure request by submitting an
  // ed25519 signature (hex-encoded) over the canonical consent message for
  // this request (see services/attestorConsent.ts). The signer must also be
  // a member of the credential's *current* on-chain attestor set — a raw
  // address string is never sufficient on its own.
  //
  // When the last required consent lands, the credential's decryption key is
  // destroyed for real.
  //
  // Body: { requestId: string, attestorAddress: string, signature: string }
  // -------------------------------------------------------------------------
  router.post('/consent', async (req: Request, res: Response) => {
    const { requestId, attestorAddress, signature } = req.body as {
      requestId?: string;
      attestorAddress?: string;
      signature?: string;
    };

    const requestStore = getRequestStore();

    if (!requestId || !requestStore.has(requestId)) {
      res.status(400).json({ error: 'Invalid or unknown requestId' });
      return;
    }
    if (!attestorAddress || typeof attestorAddress !== 'string' || attestorAddress.trim() === '') {
      res.status(400).json({ error: 'attestorAddress is required' });
      return;
    }
    if (!signature || typeof signature !== 'string' || signature.trim() === '') {
      res.status(400).json({ error: 'signature is required' });
      return;
    }

    const gdprRequest = requestStore.get(requestId)!;
    const addr = attestorAddress.trim();

    if (gdprRequest.status !== 'pending_consent') {
      res.status(400).json({ error: `Request is already ${gdprRequest.status}` });
      return;
    }

    let currentAttestors: string[];
    try {
      currentAttestors = await fetchAttestors(soroban, gdprRequest.credentialId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Could not verify attestor set: ${msg}` });
      return;
    }

    if (!currentAttestors.includes(addr)) {
      res.status(403).json({ error: 'attestorAddress is not a current attestor for this credential' });
      return;
    }

    const verification = verifyAttestorConsentSignature(addr, requestId, gdprRequest.credentialId, signature.trim());
    if (!verification.valid) {
      res.status(401).json({ error: 'Invalid attestor signature', reason: verification.reason });
      return;
    }

    const alreadyConsented = gdprRequest.attestorConsents.some((c) => c.attestor === addr);
    if (!alreadyConsented) {
      gdprRequest.attestorConsents.push({ attestor: addr, consentedAt: new Date().toISOString() });
    }

    const vault = getVault();
    if (
      gdprRequest.requiredConsents > 0 &&
      gdprRequest.attestorConsents.length >= gdprRequest.requiredConsents
    ) {
      gdprRequest.status = 'anonymized';
      const erasure = vault.eraseKey(gdprRequest.credentialId);
      gdprRequest.erasedAt = erasure.erasedAt;
      gdprRequest.commitment = vault.status(gdprRequest.credentialId).commitment;
    }

    requestStore.set(gdprRequest);

    res.json(serializeBigInt(withVaultStatus(vault, gdprRequest)));
  });

  return router;
}

import { simulateCall, u64Val } from '../soroban.js';
export default createGdprRouter({
  simulateCall,
  u64Val: u64Val as SorobanClient['u64Val'],
});
