import path from 'path';
import { DurableLog } from './durableLog.js';

export interface UserWalletLink {
  userId: string;
  stellarAddress: string;
  linkedAt: string;
}

export class UserWalletStore {
  readonly dataDir: string;
  private readonly links: DurableLog<UserWalletLink>;

  constructor(options: { dataDir?: string } = {}) {
    const dataDir = options.dataDir ?? process.env.USER_WALLET_STORE_DATA_DIR ?? path.join(process.cwd(), '.data', 'user-wallets');
    this.dataDir = dataDir;
    this.links = new DurableLog<UserWalletLink>(path.join(dataDir, 'links.jsonl'));
  }

  getWallet(userId: string): UserWalletLink | undefined {
    return this.links.get(userId);
  }

  link(userId: string, stellarAddress: string): 'linked' | 'already_linked' | 'conflict' {
    const current = this.links.get(userId);
    if (current) {
      return current.stellarAddress === stellarAddress ? 'already_linked' : 'conflict';
    }

    this.links.set(userId, {
      userId,
      stellarAddress,
      linkedAt: new Date().toISOString(),
    });
    return 'linked';
  }

  /** Reset state -- for testing only. */
  _resetForTest(): void {
    for (const userId of this.links.keys()) this.links.delete(userId);
  }
}

let defaultStore: UserWalletStore | undefined;

export function getDefaultUserWalletStore(): UserWalletStore {
  if (!defaultStore) defaultStore = new UserWalletStore();
  return defaultStore;
}

export function _setDefaultUserWalletStoreForTest(store: UserWalletStore | undefined): void {
  defaultStore = store;
}
