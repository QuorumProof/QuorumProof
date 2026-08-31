/**
 * OAuth2 / OIDC routes (#1296).
 */

import { randomBytes } from 'crypto';
import { Router, Request, Response } from 'express';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import {
  isSupportedProvider,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  resolveIdentity,
} from '../services/oauth2.js';
import { getDefaultOAuthIdentityStore } from '../services/oauthIdentityStore.js';

const router = Router();

const SIGNATURE_HEX_PATTERN = /^[0-9a-fA-F]{128}$/; // 64-byte ed25519 signature, hex-encoded

/**
 * Canonical message the Stellar keypair holder signs to authorize linking
 * their address to an OAuth2 identity. Binding provider + subject + address
 * prevents a signature collected for one identity from being replayed to
 * link a different (stolen) OAuth2 account, or the same account to a
 * different address.
 */
function buildLinkMessage(provider: string, subject: string, stellarAddress: string): string {
  return `QuorumProof OAuth2 Identity Link\nprovider:${provider}\nsubject:${subject}\naddress:${stellarAddress}`;
}

function verifyLinkSignature(
  provider: string,
  subject: string,
  stellarAddress: string,
  signatureHex: string,
): boolean {
  if (!StrKey.isValidEd25519PublicKey(stellarAddress)) return false;
  if (typeof signatureHex !== 'string' || !SIGNATURE_HEX_PATTERN.test(signatureHex)) return false;

  const message = Buffer.from(buildLinkMessage(provider, subject, stellarAddress), 'utf8');
  const signature = Buffer.from(signatureHex, 'hex');

  try {
    return Keypair.fromPublicKey(stellarAddress).verify(message, signature);
  } catch {
    return false;
  }
}

// GET /auth/oauth2/:provider/authorize — build the provider's consent screen URL
router.get('/:provider/authorize', (req: Request, res: Response) => {
  const provider = req.params.provider as string;
  if (!isSupportedProvider(provider)) {
    res.status(400).json({ error: `Unsupported OAuth2 provider: ${provider}` });
    return;
  }

  const state = randomBytes(16).toString('hex');
  const url = buildAuthorizationUrl(provider, state);
  res.json({ provider, url, state });
});

// POST /auth/oauth2/callback — exchange the auth code, verify identity, link to a Stellar address
router.post('/callback', async (req: Request, res: Response) => {
  const { provider, code, stellarAddress, signature } = req.body as {
    provider?: unknown;
    code?: unknown;
    stellarAddress?: unknown;
    signature?: unknown;
  };

  if (typeof provider !== 'string' || !isSupportedProvider(provider)) {
    res.status(400).json({ error: 'provider must be one of google, microsoft, github' });
    return;
  }
  if (typeof code !== 'string' || !code) {
    res.status(400).json({ error: 'code is required' });
    return;
  }
  if (typeof stellarAddress !== 'string' || !stellarAddress) {
    res.status(400).json({ error: 'stellarAddress is required' });
    return;
  }
  if (typeof signature !== 'string' || !signature) {
    res.status(400).json({ error: 'signature is required to prove ownership of stellarAddress' });
    return;
  }

  let identity;
  try {
    const tokens = await exchangeCodeForToken(provider, code);
    identity = await resolveIdentity(provider, tokens);
  } catch (err: unknown) {
    res.status(401).json({ error: 'OAuth2 authentication failed', message: (err as Error).message });
    return;
  }

  if (!verifyLinkSignature(provider, identity.subject, stellarAddress, signature)) {
    res.status(401).json({ error: 'Invalid signature — cannot verify ownership of stellarAddress' });
    return;
  }

  const store = getDefaultOAuthIdentityStore();
  const link = store.link(provider, identity.subject, stellarAddress, identity.email);

  res.status(200).json({
    provider,
    subject: identity.subject,
    email: identity.email,
    name: identity.name,
    stellarAddress: link.stellarAddress,
    linkedAt: link.linkedAt,
  });
});

// GET /auth/oauth2/identities/:stellarAddress — list linked identities for an address
router.get('/identities/:stellarAddress', (req: Request, res: Response) => {
  const store = getDefaultOAuthIdentityStore();
  const links = store.getByStellarAddress(req.params.stellarAddress as string);
  res.json({ data: links });
});

export default router;
