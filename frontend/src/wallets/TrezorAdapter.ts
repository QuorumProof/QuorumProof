import type { WalletAdapter, WalletType } from './types';

export class TrezorAdapter implements WalletAdapter {
  readonly type: WalletType = 'trezor';
  readonly name = 'Trezor';
  readonly icon = '🔒';
  private _address: string | null = null;
  private _accountIndex: number = 0;

  /** Build the BIP-44 derivation path for a given account index. */
  private static derivationPath(accountIndex: number): string {
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

  /**
   * Connect to the Trezor device and retrieve the Stellar public key for the
   * given `accountIndex` (BIP-44 path `m/44'/148'/<accountIndex>'`).
   *
   * @param accountIndex - Account index to use (default: 0)
   */
  async connect(accountIndex: number = 0): Promise<string> {
    const TrezorConnect = (await import('@trezor/connect')).default;

    const path = TrezorAdapter.derivationPath(accountIndex);
    const result = await TrezorConnect.stellarGetPublicKey({ path });

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

  /** Return the account index that was used when connecting. */
  getAccountIndex(): number {
    return this._accountIndex;
  }

  /**
   * Sign a transaction XDR using the Trezor device.
   *
   * @param xdr          - Transaction payload to sign
   * @param accountIndex - Account index to sign with (defaults to the index
   *                       used at connect time, falls back to 0)
   */
  async signTransaction(xdr: string, accountIndex?: number): Promise<string> {
    const TrezorConnect = (await import('@trezor/connect')).default;

    const idx = accountIndex ?? this._accountIndex;
    const path = TrezorAdapter.derivationPath(idx);

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
