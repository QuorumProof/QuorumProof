import type { WalletAdapter, WalletType } from './types';

export class LedgerAdapter implements WalletAdapter {
  readonly type: WalletType = 'ledger';
  readonly name = 'Ledger';
  readonly icon = '💻';
  private _address: string | null = null;

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

  async connect(): Promise<string> {
    const { default: TransportWebUSB } = await import('@ledgerhq/hw-transport-webusb');
    const StellarApp = (await import('@ledgerhq/hw-app-str')).default;

    const transport = await TransportWebUSB.create();
    const stellar = new StellarApp(transport);
    const result = await stellar.getPublicKey("44'/148'/0'");
    this._address = result.publicKey;
    await transport.close();
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
    const { default: TransportWebUSB } = await import('@ledgerhq/hw-transport-webusb');
    const StellarApp = (await import('@ledgerhq/hw-app-str')).default;

    const transport = await TransportWebUSB.create();
    const stellar = new StellarApp(transport);
    const txBuffer = Buffer.from(xdr, 'base64');
    const signature = await stellar.signTransaction("44'/148'/0'", txBuffer);
    await transport.close();
    return signature.signature.toString('base64');
  }
}
