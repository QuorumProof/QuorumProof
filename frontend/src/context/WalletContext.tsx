import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Networks } from '@stellar/stellar-sdk';
import type { ISupportedWallet } from '@creit.tech/stellar-wallets-kit';

import { HORIZON_URL, STELLAR_NETWORK } from '../config/env';
import {
  formatXlmBalance,
  getNativeXlmBalance,
  getXlmUsdPrice,
  xlmToUsd,
} from '../lib/wallet/balance';
import { formatWalletError, isUserRejectedError } from '../lib/wallet/formatWalletError';
import {
  connectWithWallet,
  disconnectWalletKit,
  getConnectedAddress,
  initWalletKit,
  listSupportedWallets,
  onWalletKitDisconnect,
  onWalletKitStateUpdated,
  signWalletTransaction,
  WALLET_ID_STORAGE_KEY,
  WALLET_STORAGE_KEY,
} from '../lib/wallet/wallet-kit';

interface WalletState {
  address: string | null;
  isConnected: boolean;
  isInitializing: boolean;
  isConnecting: boolean;
  network: string;
  error: string | null;
  balanceXlm: string | null;
  balanceUsd: string | null;
  balanceLoading: boolean;
  showConnectModal: boolean;
  availableWallets: ISupportedWallet[];
  walletsLoading: boolean;
  connect: (walletId: string) => Promise<void>;
  disconnect: () => void;
  openConnectModal: () => void;
  closeConnectModal: () => void;
  refreshBalance: () => Promise<void>;
  signTransaction: (xdr: string, networkPassphrase?: string) => Promise<string>;
}

const WalletContext = createContext<WalletState | undefined>(undefined);

const PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
};

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [address, setAddress] = useState<string | null>(() => {
    try {
      return localStorage.getItem(WALLET_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [isInitializing, setIsInitializing] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balanceXlm, setBalanceXlm] = useState<string | null>(null);
  const [balanceUsd, setBalanceUsd] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [availableWallets, setAvailableWallets] = useState<ISupportedWallet[]>([]);
  const [walletsLoading, setWalletsLoading] = useState(false);

  const networkPassphrase = PASSPHRASES[STELLAR_NETWORK] || Networks.TESTNET;

  const persistAddress = useCallback((next: string | null, walletId?: string | null) => {
    setAddress(next);
    try {
      if (next) {
        localStorage.setItem(WALLET_STORAGE_KEY, next);
        if (walletId) localStorage.setItem(WALLET_ID_STORAGE_KEY, walletId);
      } else {
        localStorage.removeItem(WALLET_STORAGE_KEY);
        localStorage.removeItem(WALLET_ID_STORAGE_KEY);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!address) {
      setBalanceXlm(null);
      setBalanceUsd(null);
      return;
    }
    setBalanceLoading(true);
    try {
      const [raw, usdPrice] = await Promise.all([
        getNativeXlmBalance(HORIZON_URL, address),
        getXlmUsdPrice(),
      ]);
      setBalanceXlm(formatXlmBalance(raw));
      setBalanceUsd(usdPrice != null ? xlmToUsd(raw, usdPrice) : null);
    } catch (err) {
      console.error('Failed to load wallet balance:', err);
      setBalanceXlm(null);
      setBalanceUsd(null);
    } finally {
      setBalanceLoading(false);
    }
  }, [address]);

  const refreshWallets = useCallback(async () => {
    setWalletsLoading(true);
    try {
      initWalletKit(STELLAR_NETWORK);
      const wallets = await listSupportedWallets();
      setAvailableWallets(wallets);
    } catch (err) {
      console.error('Failed to load wallets:', err);
      setAvailableWallets([]);
    } finally {
      setWalletsLoading(false);
    }
  }, []);

  useEffect(() => {
    initWalletKit(STELLAR_NETWORK);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        initWalletKit(STELLAR_NETWORK);
        const liveAddress = await getConnectedAddress();
        if (cancelled) return;
        if (liveAddress) {
          persistAddress(liveAddress);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('Wallet session restore:', formatWalletError(err));
        }
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persistAddress]);

  useEffect(() => {
    return onWalletKitStateUpdated((nextAddress) => {
      if (nextAddress && nextAddress !== address) {
        persistAddress(nextAddress);
        setError(null);
      }
    });
  }, [address, persistAddress]);

  useEffect(() => {
    return onWalletKitDisconnect(() => {
      persistAddress(null);
      setError(null);
      setBalanceXlm(null);
      setBalanceUsd(null);
    });
  }, [persistAddress]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  useEffect(() => {
    if (showConnectModal) void refreshWallets();
  }, [showConnectModal, refreshWallets]);

  const connect = useCallback(
    async (walletId: string) => {
      setIsConnecting(true);
      setError(null);
      try {
        initWalletKit(STELLAR_NETWORK);
        const pubKey = await connectWithWallet(walletId);
        persistAddress(pubKey, walletId);
        setShowConnectModal(false);
        setBalanceLoading(true);
        try {
          const [raw, usdPrice] = await Promise.all([
            getNativeXlmBalance(HORIZON_URL, pubKey),
            getXlmUsdPrice(),
          ]);
          setBalanceXlm(formatXlmBalance(raw));
          setBalanceUsd(usdPrice != null ? xlmToUsd(raw, usdPrice) : null);
        } catch (err) {
          console.error('Failed to load wallet balance:', err);
        } finally {
          setBalanceLoading(false);
        }
      } catch (err) {
        const message = isUserRejectedError(err)
          ? 'Connection was rejected. Approve access in your wallet to continue.'
          : formatWalletError(err);
        setError(message);
      } finally {
        setIsConnecting(false);
      }
    },
    [persistAddress]
  );

  const disconnect = useCallback(() => {
    void disconnectWalletKit();
    persistAddress(null);
    setError(null);
    setBalanceXlm(null);
    setBalanceUsd(null);
    setShowConnectModal(false);
  }, [persistAddress]);

  const openConnectModal = useCallback(() => {
    setError(null);
    setShowConnectModal(true);
  }, []);

  const closeConnectModal = useCallback(() => {
    if (!isConnecting) setShowConnectModal(false);
  }, [isConnecting]);

  const signTransaction = useCallback(
    async (xdr: string, passphrase?: string) => {
      if (!address) throw new Error('Connect a wallet before signing');
      return signWalletTransaction(xdr, {
        networkPassphrase: passphrase ?? networkPassphrase,
        address,
      });
    },
    [address, networkPassphrase]
  );

  const value = useMemo<WalletState>(
    () => ({
      address,
      isConnected: address !== null,
      isInitializing,
      isConnecting,
      network: STELLAR_NETWORK,
      error,
      balanceXlm,
      balanceUsd,
      balanceLoading,
      showConnectModal,
      availableWallets,
      walletsLoading,
      connect,
      disconnect,
      openConnectModal,
      closeConnectModal,
      refreshBalance,
      signTransaction,
    }),
    [
      address,
      isInitializing,
      isConnecting,
      error,
      balanceXlm,
      balanceUsd,
      balanceLoading,
      showConnectModal,
      availableWallets,
      walletsLoading,
      connect,
      disconnect,
      openConnectModal,
      closeConnectModal,
      refreshBalance,
      signTransaction,
    ]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}
