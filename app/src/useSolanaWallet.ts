import { useCallback, useEffect, useState } from "react";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

export interface BrowserWalletAdapter {
  publicKey?: PublicKey | null;
  isConnected?: boolean;
  isPhantom?: boolean;
  isBraveWallet?: boolean;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: PublicKey } | void>;
  disconnect(): Promise<void>;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAllTransactions?<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
  on?(event: "connect" | "disconnect" | "accountChanged", handler: (publicKey?: PublicKey | null) => void): void;
  off?(event: "connect" | "disconnect" | "accountChanged", handler: (publicKey?: PublicKey | null) => void): void;
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
  error: string | null;
  connect(): Promise<void>;
  switchWallet(): Promise<void>;
  disconnect(): Promise<void>;
}

function resolveBrowserWallet(): BrowserWalletAdapter | null {
  const provider = window.braveSolana ?? window.solana ?? null;

  if (!provider || typeof provider.connect !== "function" || typeof provider.signTransaction !== "function") {
    return null;
  }

  return provider;
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

export function useSolanaWallet(): SolanaWalletState {
  const [provider, setProvider] = useState<BrowserWalletAdapter | null>(null);
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localhostMode = isLocalhostSession();

  useEffect(() => {
    const nextProvider = resolveBrowserWallet();
    setProvider(nextProvider);
    setPublicKey(localhostMode ? null : nextProvider?.publicKey ?? null);

    if (!nextProvider) {
      setError("No Solana wallet detected in this browser.");
      return;
    }

    setError(null);

    let cancelled = false;
    const syncPublicKey = (nextPublicKey?: PublicKey | null) => {
      if (!cancelled) {
        setPublicKey(nextPublicKey ?? nextProvider.publicKey ?? null);
      }
    };

    const handleDisconnect = () => {
      if (!cancelled) {
        setPublicKey(null);
      }
    };

    nextProvider.on?.("connect", syncPublicKey);
    nextProvider.on?.("accountChanged", syncPublicKey);
    nextProvider.on?.("disconnect", handleDisconnect);

    if (!localhostMode) {
      void nextProvider.connect({ onlyIfTrusted: true }).then((result) => {
        if (!cancelled) {
          setPublicKey(result?.publicKey ?? nextProvider.publicKey ?? null);
        }
      }).catch(() => {
        if (!cancelled) {
          setPublicKey(nextProvider.publicKey ?? null);
        }
      });
    }

    return () => {
      cancelled = true;
      nextProvider.off?.("connect", syncPublicKey);
      nextProvider.off?.("accountChanged", syncPublicKey);
      nextProvider.off?.("disconnect", handleDisconnect);
    };
  }, [localhostMode]);

  const connect = useCallback(async () => {
    const nextProvider = resolveBrowserWallet();
    setProvider(nextProvider);

    if (!nextProvider) {
      setError("No Solana wallet detected. Open Brave Wallet or Phantom and try again.");
      return;
    }

    try {
      setConnecting(true);
      setError(null);
      const result = await nextProvider.connect();
      setPublicKey(result?.publicKey ?? nextProvider.publicKey ?? null);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchWallet = useCallback(async () => {
    const nextProvider = resolveBrowserWallet();
    setProvider(nextProvider);

    if (!nextProvider) {
      setError("No Solana wallet detected. Open Brave Wallet or Phantom and try again.");
      return;
    }

    try {
      setConnecting(true);
      setError(null);

      if (nextProvider.publicKey || nextProvider.isConnected) {
        await nextProvider.disconnect().catch(() => undefined);
        setPublicKey(null);
        await pause(150);
      }

      const result = await nextProvider.connect();
      setPublicKey(result?.publicKey ?? nextProvider.publicKey ?? null);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const nextProvider = provider ?? resolveBrowserWallet();
    if (!nextProvider) {
      return;
    }

    try {
      await nextProvider.disconnect();
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
    error,
    connect,
    switchWallet,
    disconnect,
  };
}
