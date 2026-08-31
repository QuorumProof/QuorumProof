import type { WalletAdapter, WalletType } from './types';

export class TrezorAdapter implements WalletAdapter {
  readonly type: WalletType = 'trezor';
  readonly name = 'Trezor';
  readonly icon = '🔒';
  private _address: string | null = null;
  private _accountIndex: number = 0;

  private getDerivationPath(accountIndex: number = 0): string {
    return `m/44'/148'/${accountIndex}'`;
  }

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

  async connect(accountIndex: number = 0): Promise<string> {
    const TrezorConnect = (await import('@trezor/connect')).default;

    const path = this.getDerivationPath(accountIndex);
    const result = await TrezorConnect.stellarGetPublicKey({
      path,
    });

    if (!result.success || !result.payload?.publicKey) {
      throw new Error(result.payload?.error || 'Failed to get address from Trezor');
    }

    this._address = result.payload.publicKey;
    this._accountIndex = accountIndex;
    return this._address;
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

  async signTransaction(xdr: string, accountIndex: number = this._accountIndex): Promise<string> {
    const TrezorConnect = (await import('@trezor/connect')).default;

    const path = this.getDerivationPath(accountIndex);
    const result = await TrezorConnect.stellarSignTransaction({
      path,
      transaction: xdr,
    });

    if (!result.success) {
      throw new Error(result.payload?.error || 'Failed to sign with Trezor');
    }

    return result.payload.signature;
  }
}
