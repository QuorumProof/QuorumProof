import type { WalletAdapter, WalletType } from './types';

export class TrezorAdapter implements WalletAdapter {
  readonly type: WalletType = 'trezor';
  readonly name = 'Trezor';
  readonly icon = '🔒';
  private _address: string | null = null;

  async isAvailable(): Promise<boolean> {
    try {
      const TrezorConnect = (await import('@trezor/connect')).default;
      const result = await TrezorConnect.init({
        manifest: {
          email: 'support@quorumproof.com',
          appUrl: 'https://quorumproof.com',
        },
      });
      return result;
    } catch {
      return false;
    }
  }

  async connect(): Promise<string> {
    const TrezorConnect = (await import('@trezor/connect')).default;

    const result = await TrezorConnect.stellarGetPublicKey({
      path: "m/44'/148'/0'",
    });

    if (!result.success || !result.payload?.publicKey) {
      throw new Error(result.payload?.error || 'Failed to get address from Trezor');
    }

    this._address = result.payload.publicKey;
    return this._address;
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
    const TrezorConnect = (await import('@trezor/connect')).default;

    const result = await TrezorConnect.stellarSignTransaction({
      path: "m/44'/148'/0'",
      transaction: xdr,
    });

    if (!result.success) {
      throw new Error(result.payload?.error || 'Failed to sign with Trezor');
    }

    return result.payload.signature;
  }
}
