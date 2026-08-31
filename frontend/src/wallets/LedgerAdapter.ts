import type { WalletAdapter, WalletType } from './types';

export class LedgerAdapter implements WalletAdapter {
  readonly type: WalletType = 'ledger';
  readonly name = 'Ledger';
  readonly icon = '💻';
  private _address: string | null = null;
  private _accountIndex: number = 0;

  private getDerivationPath(accountIndex: number = 0): string {
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

  async connect(accountIndex: number = 0): Promise<string> {
    const { default: TransportWebUSB } = await import('@ledgerhq/hw-transport-webusb');
    const StellarApp = (await import('@ledgerhq/hw-app-str')).default;

    const transport = await TransportWebUSB.create();
    const stellar = new StellarApp(transport);
    const path = this.getDerivationPath(accountIndex);
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

  getAccountIndex(): number {
    return this._accountIndex;
  }

  async signTransaction(xdr: string, accountIndex: number = this._accountIndex): Promise<string> {
    const { default: TransportWebUSB } = await import('@ledgerhq/hw-transport-webusb');
    const StellarApp = (await import('@ledgerhq/hw-app-str')).default;

    const idx = accountIndex ?? this._accountIndex;
    const path = LedgerAdapter.derivationPath(idx);

    const transport = await TransportWebUSB.create();
    const stellar = new StellarApp(transport);
    const txBuffer = Buffer.from(xdr, 'base64');
    const path = this.getDerivationPath(accountIndex);
    const signature = await stellar.signTransaction(path, txBuffer);
    await transport.close();
    return signature.signature.toString('base64');
  }
}
