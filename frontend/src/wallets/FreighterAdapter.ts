import {
  isConnected,
  isAllowed,
  setAllowed,
  getAddress,
} from '@stellar/freighter-api';
import type { WalletAdapter, WalletType } from './types';

export class FreighterAdapter implements WalletAdapter {
  readonly type: WalletType = 'freighter';
  readonly name = 'Freighter';
  readonly icon = '🦊';
  private _address: string | null = null;

  async isAvailable(): Promise<boolean> {
    try {
      const result = await isConnected();
      return result.isConnected;
    } catch {
      return false;
    }
  }

  async connect(): Promise<string> {
    const connected = await isConnected();
    if (!connected.isConnected) {
      throw new Error('Freighter extension not detected');
    }
    await setAllowed();
    const result = await getAddress();
    if (!result.address) {
      throw new Error('Failed to get address from Freighter');
    }
    this._address = result.address;
    return result.address;
  }

  disconnect(): void {
    this._address = null;
  }

  isConnected(): boolean {
    return this._address !== null;
  }

  getAddress(): string | null {
    return this._address;
  }

  async signTransaction(xdr: string): Promise<string> {
    const { signTransaction } = await import('@stellar/freighter-api');
    const result = await signTransaction(xdr);
    if ('error' in result && result.error) {
      throw new Error(result.error);
    }
    return result.signedTxXdr;
  }
}
