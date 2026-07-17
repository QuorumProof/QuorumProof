export type WalletType = 'freighter' | 'ledger' | 'trezor';

export interface WalletAdapter {
  type: WalletType;
  name: string;
  icon: string;
  isAvailable(): Promise<boolean>;
  connect(): Promise<string>;
  disconnect(): void;
  isConnected(): boolean;
  getAddress(): string | null;
  signTransaction?(xdr: string): Promise<string>;
}

export interface WalletState {
  address: string | null;
  walletType: WalletType | null;
  isConnected: boolean;
  isInitializing: boolean;
  network: string;
  error: string | null;
  connect: (type: WalletType) => Promise<void>;
  disconnect: () => void;
  getAdapter: () => WalletAdapter | null;
}
