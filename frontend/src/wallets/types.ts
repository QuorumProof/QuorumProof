export type WalletType = 'freighter' | 'ledger' | 'trezor';

export interface WalletAdapter {
  type: WalletType;
  name: string;
  icon: string;
  isAvailable(): Promise<boolean>;
  connect(accountIndex?: number): Promise<string>;
  disconnect(): void;
  isConnected(): boolean;
  getAddress(): string | null;
  getAccountIndex?(): number;
  signTransaction?(xdr: string, accountIndex?: number): Promise<string>;
}

export interface WalletState {
  address: string | null;
  walletType: WalletType | null;
  isConnected: boolean;
  isInitializing: boolean;
  network: string;
  error: string | null;
  accountIndex?: number;
  connect: (type: WalletType, accountIndex?: number) => Promise<void>;
  disconnect: () => void;
  getAdapter: () => WalletAdapter | null;
}
