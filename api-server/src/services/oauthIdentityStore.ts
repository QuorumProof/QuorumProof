/**
 * OAuth2/OIDC identity linking store (#1296).
 * Maps a (provider, subject) pair -- the stable identifier an IdP issues for
 * an account -- to the Stellar address the user has proven ownership of, so
 * an enterprise SSO login can be resolved to an on-chain identity.
 */

import path from 'path';
import { DurableLog } from './durableLog.js';

export interface OAuthIdentityLink {
  provider: string;
  subject: string;
  stellarAddress: string;
  email?: string;
  linkedAt: string;
}

function identityKey(provider: string, subject: string): string {
  return `${provider}:${subject}`;
}

export class OAuthIdentityStore {
  readonly dataDir: string;
  private readonly links: DurableLog<OAuthIdentityLink>;

  constructor(options: { dataDir?: string } = {}) {
    const dataDir = options.dataDir ?? process.env.OAUTH_IDENTITY_STORE_DATA_DIR ?? path.join(process.cwd(), '.data', 'oauth-identities');
    this.dataDir = dataDir;
    this.links = new DurableLog<OAuthIdentityLink>(path.join(dataDir, 'links.jsonl'));
  }

  link(provider: string, subject: string, stellarAddress: string, email?: string): OAuthIdentityLink {
    const link: OAuthIdentityLink = {
      provider,
      subject,
      stellarAddress,
      email,
      linkedAt: new Date().toISOString(),
    };
    this.links.set(identityKey(provider, subject), link);
    return link;
  }

  getByIdentity(provider: string, subject: string): OAuthIdentityLink | undefined {
    return this.links.get(identityKey(provider, subject));
  }

  getByStellarAddress(stellarAddress: string): OAuthIdentityLink[] {
    return this.links.values().filter((l) => l.stellarAddress === stellarAddress);
  }

  unlink(provider: string, subject: string): boolean {
    const key = identityKey(provider, subject);
    if (!this.links.has(key)) return false;
    this.links.delete(key);
    return true;
  }

  /** Reset state -- for testing only. */
  _resetForTest(): void {
    for (const key of this.links.keys()) this.links.delete(key);
  }
}

let defaultStore: OAuthIdentityStore | undefined;

export function getDefaultOAuthIdentityStore(): OAuthIdentityStore {
  if (!defaultStore) defaultStore = new OAuthIdentityStore();
  return defaultStore;
}

export function _setDefaultOAuthIdentityStoreForTest(store: OAuthIdentityStore | undefined): void {
  defaultStore = store;
}
