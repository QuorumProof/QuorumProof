import type { ISupportedWallet } from '@creit.tech/stellar-wallets-kit';

/** Curated wallets for the connect modal — major Stellar options only. */
export const FEATURED_WALLET_IDS = [
  'freighter',
  'albedo',
  'xbull',
  'lobstr',
  'rabet',
  'wallet_connect',
] as const;

export function filterFeaturedWallets(wallets: ISupportedWallet[]): ISupportedWallet[] {
  const byId = new Map(wallets.map((w) => [w.id, w]));
  return FEATURED_WALLET_IDS.map((id) => byId.get(id)).filter(
    (w): w is ISupportedWallet => w != null
  );
}
