import { describe, it, expect } from 'vitest';
import type { ISupportedWallet } from '@creit.tech/stellar-wallets-kit';
import { filterFeaturedWallets, FEATURED_WALLET_IDS } from '../wallet-list';

function mockWallet(id: string, name: string): ISupportedWallet {
  return {
    id,
    name,
    type: 'HOT_WALLET',
    isAvailable: true,
    isPlatformWrapper: false,
    icon: '',
    url: '',
  };
}

describe('filterFeaturedWallets', () => {
  it('returns only the six curated wallets in display order', () => {
    const all = [
      mockWallet('fordefi', 'Fordefi'),
      mockWallet('freighter', 'Freighter'),
      mockWallet('albedo', 'Albedo'),
      mockWallet('xbull', 'xBull'),
      mockWallet('lobstr', 'LOBSTR'),
      mockWallet('rabet', 'Rabet'),
      mockWallet('wallet_connect', 'WalletConnect'),
      mockWallet('klever', 'Klever'),
    ];

    const featured = filterFeaturedWallets(all);

    expect(featured).toHaveLength(6);
    expect(featured.map((w) => w.id)).toEqual([...FEATURED_WALLET_IDS]);
  });

  it('omits wallets not in the curated list', () => {
    const featured = filterFeaturedWallets([mockWallet('fordefi', 'Fordefi')]);
    expect(featured).toHaveLength(0);
  });
});
