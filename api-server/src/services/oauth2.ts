/**
 * OAuth2 / OIDC support (#1296).
 *
 * The API previously only supported Stellar keypair auth. This adds
 * authorization-code exchange against Google, Microsoft, and GitHub, OIDC ID
 * token validation (RS256, verified against each provider's published JWKS),
 * and a GitHub-specific fallback since GitHub's OAuth2 implementation has no
 * ID token -- its identity comes from the authenticated user API instead.
 *
 * Deliberately built on Node's built-in `crypto` (RSA-JWK verification) and
 * global `fetch` rather than a JWT/OIDC library, since no new dependency can
 * be installed for this change.
 */

import { createPublicKey, verify as verifyRsaSignature } from 'crypto';

export type OAuthProviderName = 'google' | 'microsoft' | 'github';

export interface OAuthProviderConfig {
  name: OAuthProviderName;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Absent for GitHub -- it has no OIDC discovery / ID tokens. */
  jwksUri?: string;
  /** Expected `iss` claim. Absent for providers with a per-tenant issuer (Microsoft). */
  issuer?: string;
  scope: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function env(name: string): string {
  return process.env[name] ?? '';
}

export function getProviderConfig(provider: OAuthProviderName): OAuthProviderConfig {
  switch (provider) {
    case 'google':
      return {
        name: 'google',
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
        issuer: 'https://accounts.google.com',
        scope: 'openid email profile',
        clientId: env('OAUTH_GOOGLE_CLIENT_ID'),
        clientSecret: env('OAUTH_GOOGLE_CLIENT_SECRET'),
        redirectUri: env('OAUTH_GOOGLE_REDIRECT_URI'),
      };
    case 'microsoft':
      return {
        name: 'microsoft',
        authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
        scope: 'openid email profile',
        clientId: env('OAUTH_MICROSOFT_CLIENT_ID'),
        clientSecret: env('OAUTH_MICROSOFT_CLIENT_SECRET'),
        redirectUri: env('OAUTH_MICROSOFT_REDIRECT_URI'),
      };
    case 'github':
      return {
        name: 'github',
        authorizationEndpoint: 'https://github.com/login/oauth/authorize',
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
        scope: 'read:user user:email',
        clientId: env('OAUTH_GITHUB_CLIENT_ID'),
        clientSecret: env('OAUTH_GITHUB_CLIENT_SECRET'),
        redirectUri: env('OAUTH_GITHUB_REDIRECT_URI'),
      };
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown OAuth2 provider: ${exhaustive}`);
    }
  }
}

const SUPPORTED_PROVIDERS: readonly OAuthProviderName[] = ['google', 'microsoft', 'github'];

export function isSupportedProvider(provider: string): provider is OAuthProviderName {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(provider);
}

export function buildAuthorizationUrl(provider: OAuthProviderName, state: string): string {
  const config = getProviderConfig(provider);
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  return url.toString();
}

export interface TokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
}

export async function exchangeCodeForToken(provider: OAuthProviderName, code: string): Promise<TokenResponse> {
  const config = getProviderConfig(provider);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`OAuth2 token exchange failed for ${provider}: ${response.status}`);
  }
  return (await response.json()) as TokenResponse;
}

interface Jwk {
  kty: string;
  kid: string;
  n?: string;
  e?: string;
}

interface JwksCacheEntry {
  keys: Jwk[];
  fetchedAt: number;
}

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map<string, JwksCacheEntry>();

async function fetchJwks(jwksUri: string): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }

  const response = await fetch(jwksUri);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS from ${jwksUri}: ${response.status}`);
  }
  const data = (await response.json()) as { keys: Jwk[] };
  jwksCache.set(jwksUri, { keys: data.keys, fetchedAt: Date.now() });
  return data.keys;
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  email?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Validates an OIDC ID token's RS256 signature against the provider's JWKS,
 * then checks `iss`/`aud`/`exp` per the OIDC core spec. Only RS256 is
 * supported -- the algorithm Google and Microsoft's default OIDC
 * configuration both issue.
 */
export async function verifyIdToken(provider: OAuthProviderName, idToken: string): Promise<IdTokenClaims> {
  const config = getProviderConfig(provider);
  if (!config.jwksUri) {
    throw new Error(`Provider ${provider} does not issue OIDC ID tokens`);
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed ID token');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as { alg: string; kid: string };
  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported ID token algorithm: ${header.alg}`);
  }

  const keys = await fetchJwks(config.jwksUri);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk || !jwk.n || !jwk.e) {
    throw new Error('No matching JWKS key for ID token kid');
  }

  const publicKey = createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
    format: 'jwk',
  });

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signature = base64UrlDecode(signatureB64);

  const valid = verifyRsaSignature('RSA-SHA256', signingInput, publicKey, signature);
  if (!valid) {
    throw new Error('ID token signature verification failed');
  }

  const claims = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as IdTokenClaims;

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) {
    throw new Error('ID token has expired');
  }
  if (config.issuer && claims.iss !== config.issuer) {
    throw new Error(`Unexpected ID token issuer: ${claims.iss}`);
  }
  if (provider === 'microsoft' && !claims.iss.startsWith('https://login.microsoftonline.com/')) {
    // Microsoft's `iss` is tenant-specific (.../{tenantId}/v2.0), so it is
    // checked by prefix rather than exact match against a fixed issuer.
    throw new Error(`Unexpected ID token issuer: ${claims.iss}`);
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.clientId)) {
    throw new Error('ID token audience does not match this client');
  }

  return claims;
}

export interface OAuthIdentity {
  provider: OAuthProviderName;
  subject: string;
  email?: string;
  name?: string;
}

interface GithubUser {
  id: number;
  login: string;
  email: string | null;
  name: string | null;
}

async function fetchGithubIdentity(accessToken: string): Promise<OAuthIdentity> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'QuorumProof',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub user lookup failed: ${response.status}`);
  }
  const user = (await response.json()) as GithubUser;
  return {
    provider: 'github',
    subject: String(user.id),
    email: user.email ?? undefined,
    name: user.name ?? user.login,
  };
}

/**
 * Resolves a completed OAuth2 token response into a normalized identity.
 * Google/Microsoft identities come from their signed OIDC ID token; GitHub
 * has no ID token, so its identity comes from the authenticated user API.
 */
export async function resolveIdentity(provider: OAuthProviderName, tokens: TokenResponse): Promise<OAuthIdentity> {
  if (provider === 'github') {
    if (!tokens.access_token) {
      throw new Error('GitHub token response did not include an access_token');
    }
    return fetchGithubIdentity(tokens.access_token);
  }

  if (!tokens.id_token) {
    throw new Error(`${provider} token response did not include an id_token`);
  }
  const claims = await verifyIdToken(provider, tokens.id_token);
  return {
    provider,
    subject: claims.sub,
    email: claims.email,
    name: typeof claims.name === 'string' ? claims.name : undefined,
  };
}
