import {
  StellarWalletsKit,
  Networks,
  KitEventType,
  type ISupportedWallet,
} from '@creit.tech/stellar-wallets-kit';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';

import { formatWalletError, isUserRejectedError } from './formatWalletError';
import { filterFeaturedWallets } from './wallet-list';

export { FEATURED_WALLET_IDS, filterFeaturedWallets } from './wallet-list';

export const WALLET_STORAGE_KEY = 'quorum-proof-wallet-address';
export const WALLET_ID_STORAGE_KEY = 'quorum-proof-wallet-id';

const CONNECT_TIMEOUT_MS = 30_000;

let initialized = false;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms
    );
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export function networkNameToKitNetwork(name: string): Networks {
  switch (name) {
    case 'mainnet':
      return Networks.PUBLIC;
    case 'futurenet':
      return Networks.FUTURENET;
    default:
      return Networks.TESTNET;
  }
}

export function initWalletKit(network: string = 'testnet'): void {
  const kitNetwork = networkNameToKitNetwork(network);
  if (!initialized) {
    StellarWalletsKit.init({
      network: kitNetwork,
      modules: defaultModules(),
    });
    initialized = true;
    return;
  }
  StellarWalletsKit.setNetwork(kitNetwork);
}

export async function listSupportedWallets(): Promise<ISupportedWallet[]> {
  initWalletKit();
  const all = await StellarWalletsKit.refreshSupportedWallets();
  return filterFeaturedWallets(all);
}

export async function getConnectedAddress(): Promise<string | null> {
  try {
    const { address } = await StellarWalletsKit.getAddress();
    return address || null;
  } catch {
    return null;
  }
}

export async function connectWithWallet(walletId: string): Promise<string> {
  initWalletKit();
  StellarWalletsKit.setWallet(walletId);
  const { address } = await withTimeout(
    StellarWalletsKit.fetchAddress(),
    CONNECT_TIMEOUT_MS,
    'Wallet connection'
  );
  if (!address) throw new Error('No wallet address returned');
  return address;
}

export async function signWalletTransaction(
  xdr: string,
  opts?: { networkPassphrase?: string; address?: string }
): Promise<string> {
  try {
    const signed = await withTimeout(
      StellarWalletsKit.signTransaction(xdr, opts),
      CONNECT_TIMEOUT_MS,
      'Transaction signing'
    );
    if (!signed.signedTxXdr) throw new Error('Wallet did not return a signed transaction');
    return signed.signedTxXdr;
  } catch (error) {
    if (isUserRejectedError(error)) {
      throw new Error('Transaction signing was rejected');
    }
    throw error instanceof Error ? error : new Error(formatWalletError(error));
  }
}

export async function disconnectWalletKit(): Promise<void> {
  try {
    await StellarWalletsKit.disconnect();
  } catch {
    /* no active session */
  }
}

export function onWalletKitDisconnect(callback: () => void): () => void {
  return StellarWalletsKit.on(KitEventType.DISCONNECT, callback);
}

export function onWalletKitStateUpdated(
  callback: (address: string | undefined) => void
): () => void {
  return StellarWalletsKit.on(KitEventType.STATE_UPDATED, (event) => {
    callback(event.payload.address);
  });
}

export { formatWalletError };
