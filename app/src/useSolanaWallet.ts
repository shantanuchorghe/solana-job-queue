import { useCallback, useEffect, useMemo, useState } from "react";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

export interface BrowserWalletAdapter {
  publicKey?: PublicKey | null;
  isConnected?: boolean;
  isPhantom?: boolean;
  isBraveWallet?: boolean;
  providers?: BrowserWalletAdapter[];
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: PublicKey } | void>;
  disconnect(): Promise<void>;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAllTransactions?<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
  on?(event: "connect" | "disconnect" | "accountChanged", handler: (publicKey?: PublicKey | null) => void): void;
  off?(event: "connect" | "disconnect" | "accountChanged", handler: (publicKey?: PublicKey | null) => void): void;
}

export type WalletProviderId = "phantom" | "brave" | "solana";

export interface WalletOption {
  id: WalletProviderId;
  label: string;
}

interface WalletRecord extends WalletOption {
  provider: BrowserWalletAdapter;
}

export interface SolanaWalletState {
  available: boolean;
  connected: boolean;
  connecting: boolean;
  localhostMode: boolean;
  publicKey: PublicKey | null;
  address: string | null;
  shortAddress: string | null;
  provider: BrowserWalletAdapter | null;
  availableWallets: WalletOption[];
  selectedWalletId: WalletProviderId | null;
  selectedWalletLabel: string | null;
  error: string | null;
  connect(): Promise<void>;
  switchWallet(): Promise<void>;
  selectWallet(walletId: WalletProviderId): Promise<void>;
  disconnect(): Promise<void>;
}

const WALLET_STORAGE_KEY = "solqueue-wallet-provider";
const WALLET_ORDER: WalletProviderId[] = ["phantom", "brave", "solana"];

function isWalletProvider(value: unknown): value is BrowserWalletAdapter {
  return value != null
    && typeof value === "object"
    && typeof (value as BrowserWalletAdapter).connect === "function"
    && typeof (value as BrowserWalletAdapter).disconnect === "function"
    && typeof (value as BrowserWalletAdapter).signTransaction === "function";
}

function providerId(provider: BrowserWalletAdapter): WalletProviderId {
  if (provider.isPhantom) {
    return "phantom";
  }

  if (provider.isBraveWallet) {
    return "brave";
  }

  return "solana";
}

function providerLabel(id: WalletProviderId): string {
  switch (id) {
    case "phantom":
      return "Phantom";
    case "brave":
      return "Brave";
    default:
      return "Injected";
  }
}

function compareWallets(left: WalletRecord, right: WalletRecord): number {
  return WALLET_ORDER.indexOf(left.id) - WALLET_ORDER.indexOf(right.id);
}

function collectWallets(): WalletRecord[] {
  const wallets = new Map<WalletProviderId, WalletRecord>();

  const register = (provider: unknown) => {
    if (!isWalletProvider(provider)) {
      return;
    }

    const id = providerId(provider);
    if (!wallets.has(id)) {
      wallets.set(id, { id, label: providerLabel(id), provider });
    }
  };

  register(window.phantom?.solana);
  register(window.braveSolana);

  if (Array.isArray(window.solana?.providers)) {
    window.solana.providers.forEach(register);
  }

  register(window.solana);

  return Array.from(wallets.values()).sort(compareWallets);
}

function shortenAddress(value: string | null): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= 14) {
    return value;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isLocalhostSession(): boolean {
  const hostname = window.location.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readStoredWalletId(): WalletProviderId | null {
  const stored = window.localStorage.getItem(WALLET_STORAGE_KEY);
  return WALLET_ORDER.includes(stored as WalletProviderId) ? (stored as WalletProviderId) : null;
}

function writeStoredWalletId(walletId: WalletProviderId | null) {
  if (!walletId) {
    window.localStorage.removeItem(WALLET_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(WALLET_STORAGE_KEY, walletId);
}

function pickWalletId(wallets: WalletRecord[], preferredId: WalletProviderId | null): WalletProviderId | null {
  if (preferredId && wallets.some((wallet) => wallet.id === preferredId)) {
    return preferredId;
  }

  return wallets[0]?.id ?? null;
}

export function useSolanaWallet(): SolanaWalletState {
  const localhostMode = isLocalhostSession();
  const [availableWallets, setAvailableWallets] = useState<WalletRecord[]>([]);
  const [selectedWalletId, setSelectedWalletId] = useState<WalletProviderId | null>(() => readStoredWalletId());
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const discovered = collectWallets();
    setAvailableWallets(discovered);
    setSelectedWalletId((current) => pickWalletId(discovered, current ?? readStoredWalletId()));
  }, []);

  const selectedWallet = useMemo(
    () => availableWallets.find((wallet) => wallet.id === selectedWalletId) ?? null,
    [availableWallets, selectedWalletId]
  );

  const provider = selectedWallet?.provider ?? null;

  useEffect(() => {
    writeStoredWalletId(selectedWalletId);
  }, [selectedWalletId]);

  useEffect(() => {
    if (!provider) {
      setPublicKey(null);
      if (availableWallets.length === 0) {
        setError("No Solana wallet detected in this browser.");
      }
      return;
    }

    setPublicKey(localhostMode ? null : provider.publicKey ?? null);
    setError(null);

    let cancelled = false;
    const syncPublicKey = (nextPublicKey?: PublicKey | null) => {
      if (!cancelled) {
        setPublicKey(nextPublicKey ?? provider.publicKey ?? null);
      }
    };

    const handleDisconnect = () => {
      if (!cancelled) {
        setPublicKey(null);
      }
    };

    provider.on?.("connect", syncPublicKey);
    provider.on?.("accountChanged", syncPublicKey);
    provider.on?.("disconnect", handleDisconnect);

    if (!localhostMode) {
      void provider.connect({ onlyIfTrusted: true }).then((result) => {
        if (!cancelled) {
          setPublicKey(result?.publicKey ?? provider.publicKey ?? null);
        }
      }).catch(() => {
        if (!cancelled) {
          setPublicKey(provider.publicKey ?? null);
        }
      });
    }

    return () => {
      cancelled = true;
      provider.off?.("connect", syncPublicKey);
      provider.off?.("accountChanged", syncPublicKey);
      provider.off?.("disconnect", handleDisconnect);
    };
  }, [availableWallets.length, localhostMode, provider]);

  const connect = useCallback(async () => {
    const discovered = collectWallets();
    setAvailableWallets(discovered);

    const nextWalletId = pickWalletId(discovered, selectedWalletId ?? readStoredWalletId());
    const nextWallet = discovered.find((wallet) => wallet.id === nextWalletId) ?? null;
    setSelectedWalletId(nextWalletId);

    if (!nextWallet) {
      setError("No Solana wallet detected. Open Brave Wallet or Phantom and try again.");
      return;
    }

    try {
      setConnecting(true);
      setError(null);
      const result = await nextWallet.provider.connect();
      setPublicKey(result?.publicKey ?? nextWallet.provider.publicKey ?? null);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setConnecting(false);
    }
  }, [selectedWalletId]);

  const switchWallet = useCallback(async () => {
    const discovered = collectWallets();
    setAvailableWallets(discovered);

    const nextWalletId = pickWalletId(discovered, selectedWalletId ?? readStoredWalletId());
    const nextWallet = discovered.find((wallet) => wallet.id === nextWalletId) ?? null;
    setSelectedWalletId(nextWalletId);

    if (!nextWallet) {
      setError("No Solana wallet detected. Open Brave Wallet or Phantom and try again.");
      return;
    }

    try {
      setConnecting(true);
      setError(null);

      if (nextWallet.provider.publicKey || nextWallet.provider.isConnected) {
        await nextWallet.provider.disconnect().catch(() => undefined);
        setPublicKey(null);
        await pause(150);
      }

      const result = await nextWallet.provider.connect();
      setPublicKey(result?.publicKey ?? nextWallet.provider.publicKey ?? null);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setConnecting(false);
    }
  }, [selectedWalletId]);

  const selectWallet = useCallback(async (walletId: WalletProviderId) => {
    if (walletId === selectedWalletId) {
      return;
    }

    if (provider?.publicKey || provider?.isConnected) {
      await provider.disconnect().catch(() => undefined);
    }

    setPublicKey(null);
    setError(null);
    setSelectedWalletId(walletId);
  }, [provider, selectedWalletId]);

  const disconnect = useCallback(async () => {
    if (!provider) {
      return;
    }

    try {
      await provider.disconnect();
      setPublicKey(null);
      setError(null);
    } catch (nextError) {
      setError((nextError as Error).message);
    }
  }, [provider]);

  const address = publicKey?.toBase58() ?? null;

  return {
    available: provider != null,
    connected: publicKey != null,
    connecting,
    localhostMode,
    publicKey,
    address,
    shortAddress: shortenAddress(address),
    provider,
    availableWallets: availableWallets.map(({ id, label }) => ({ id, label })),
    selectedWalletId,
    selectedWalletLabel: selectedWallet?.label ?? null,
    error,
    connect,
    switchWallet,
    selectWallet,
    disconnect,
  };
}
