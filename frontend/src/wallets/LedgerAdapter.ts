import type { WalletAdapter, WalletType } from './types';

export class LedgerAdapter implements WalletAdapter {
  readonly type: WalletType = 'ledger';
  readonly name = 'Ledger';
  readonly icon = '💻';
  private _address: string | null = null;
  private _accountIndex: number = 0;

  /** Build the BIP-44 derivation path for a given account index. */
  private static derivationPath(accountIndex: number): string {
    return `44'/148'/${accountIndex}'`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { default: TransportWebUSB } = await import('@ledgerhq/hw-transport-webusb');
      const supported = await TransportWebUSB.isSupported();
      if (!supported) return false;
      const transport = await TransportWebUSB.create();
      await transport.close();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Connect to the Ledger device and retrieve the Stellar address for the
   * given `accountIndex` (BIP-44 path `44'/148'/<accountIndex>'`).
   *
   * @param accountIndex - Account index to use (default: 0)
   */
  async connect(accountIndex: number = 0): Promise<string> {
    const { default: TransportWebUSB } = await import('@ledgerhq/hw-transport-webusb');
    const StellarApp = (await import('@ledgerhq/hw-app-str')).default;

    const transport = await TransportWebUSB.create();
    const stellar = new StellarApp(transport);
    const path = LedgerAdapter.derivationPath(accountIndex);
    const result = await stellar.getPublicKey(path);
    this._address = result.publicKey;
    this._accountIndex = accountIndex;
    await transport.close();
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
   * Sign a transaction XDR using the Ledger device.
   *
   * @param xdr          - Base-64 encoded transaction XDR
   * @param accountIndex - Account index to sign with (defaults to the index
   *                       used at connect time, falls back to 0)
   */
  async signTransaction(xdr: string, accountIndex?: number): Promise<string> {
    const { default: TransportWebUSB } = await import('@ledgerhq/hw-transport-webusb');
    const StellarApp = (await import('@ledgerhq/hw-app-str')).default;

    const idx = accountIndex ?? this._accountIndex;
    const path = LedgerAdapter.derivationPath(idx);

    const transport = await TransportWebUSB.create();
    const stellar = new StellarApp(transport);
    const txBuffer = Buffer.from(xdr, 'base64');
    const signature = await stellar.signTransaction(path, txBuffer);
    await transport.close();
    return signature.signature.toString('base64');
  }
}
