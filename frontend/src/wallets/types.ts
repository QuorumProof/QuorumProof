export type WalletType = 'freighter' | 'ledger' | 'trezor';

export interface WalletAdapter {
  type: WalletType;
  name: string;
  icon: string;
  isAvailable(): Promise<boolean>;
  /** Connect to the wallet. Hardware wallets accept an optional accountIndex. */
  connect(accountIndex?: number): Promise<string>;
  disconnect(): void;
  isConnected(): boolean;
  getAddress(): string | null;
  /** Returns the account index used for this connection (hardware wallets only). */
  getAccountIndex?(): number;
  /** Sign a transaction XDR. Hardware wallets accept an optional accountIndex. */
  signTransaction?(xdr: string, accountIndex?: number): Promise<string>;
}

export interface WalletState {
  address: string | null;
  wallets: string[];
  walletType: WalletType | null;
  /** BIP-44 account index persisted alongside the active wallet type. */
  accountIndex: number;
  activeIndex: number;
  isConnected: boolean;
  hasFreighter: boolean;
  isInitializing: boolean;
  network: string;
  error: string | null;
  availableWallets: WalletType[];
  connect: (type?: WalletType, accountIndex?: number) => Promise<void>;
  disconnect: () => void;
  switchWallet: (index: number) => void;
}
