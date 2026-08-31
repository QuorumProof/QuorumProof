import {
  isConnected,
  setAllowed,
  getAddress,
} from '@stellar/freighter-api';
import type { WalletAdapter, WalletType } from './types';

export class FreighterAdapter implements WalletAdapter {
  readonly type: WalletType = 'freighter';
  readonly name = 'Freighter';
  readonly icon = '🦊';
  private _address: string | null = null;
  private _accountIndex: number = 0;

  async isAvailable(): Promise<boolean> {
    try {
      const result = await isConnected();
      return result.isConnected;
    } catch {
      return false;
    }
  }

  async connect(accountIndex: number = 0): Promise<string> {
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
    this._accountIndex = accountIndex;
    return result.address;
  }

  disconnect(): void {
    this._address = null;
    this._accountIndex = 0;
  }

  isConnected(): boolean {
    return this._address !== null;
  }

  getAddress(): string | null {
    return this._address;
  }

  getAccountIndex(): number {
    return this._accountIndex;
  }

  async signTransaction(xdr: string, accountIndex?: number): Promise<string> {
    const { signTransaction } = await import('@stellar/freighter-api');
    const result = await signTransaction(xdr);
    if ('error' in result && result.error) {
      throw new Error(result.error);
    }
    return result.signedTxXdr;
  }
}
