import type { WalletAdapter, WalletType } from './types';
import { FreighterAdapter } from './FreighterAdapter';
import { LedgerAdapter } from './LedgerAdapter';
import { TrezorAdapter } from './TrezorAdapter';

const adapters: Record<WalletType, WalletAdapter> = {
  freighter: new FreighterAdapter(),
  ledger: new LedgerAdapter(),
  trezor: new TrezorAdapter(),
};

export function getWalletAdapter(type: WalletType): WalletAdapter {
  return adapters[type];
}

export function getAllWalletAdapters(): WalletAdapter[] {
  return Object.values(adapters);
}

export async function detectAvailableWallets(): Promise<WalletType[]> {
  const available: WalletType[] = [];
  for (const [type, adapter] of Object.entries(adapters)) {
    try {
      if (await adapter.isAvailable()) {
        available.push(type as WalletType);
      }
    } catch {
      // skip unavailable wallets
    }
  }
  return available;
}
