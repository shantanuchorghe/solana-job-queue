import type { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

declare global {
  interface SolanaInjectedProvider {
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

  interface Window {
    solana?: SolanaInjectedProvider;
    braveSolana?: SolanaInjectedProvider;
  }
}

export {};
