"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.useSolanaWallet = useSolanaWallet;
const react_1 = require("react");
const WALLET_STORAGE_KEY = "decqueue-wallet-provider";
const WALLET_ORDER = ["phantom", "brave", "solana"];
function isWalletProvider(value) {
    return value != null
        && typeof value === "object"
        && typeof value.connect === "function"
        && typeof value.disconnect === "function"
        && typeof value.signTransaction === "function";
}
function providerId(provider) {
    if (provider.isPhantom) {
        return "phantom";
    }
    if (provider.isBraveWallet) {
        return "brave";
    }
    return "solana";
}
function providerLabel(id) {
    switch (id) {
        case "phantom":
            return "Phantom";
        case "brave":
            return "Brave";
        default:
            return "Injected";
    }
}
function compareWallets(left, right) {
    return WALLET_ORDER.indexOf(left.id) - WALLET_ORDER.indexOf(right.id);
}
function collectWallets() {
    var _a, _b;
    const wallets = new Map();
    const register = (provider) => {
        if (!isWalletProvider(provider)) {
            return;
        }
        const id = providerId(provider);
        if (!wallets.has(id)) {
            wallets.set(id, { id, label: providerLabel(id), provider });
        }
    };
    register((_a = window.phantom) === null || _a === void 0 ? void 0 : _a.solana);
    register(window.braveSolana);
    if (Array.isArray((_b = window.solana) === null || _b === void 0 ? void 0 : _b.providers)) {
        window.solana.providers.forEach(register);
    }
    register(window.solana);
    return Array.from(wallets.values()).sort(compareWallets);
}
function shortenAddress(value) {
    if (!value) {
        return null;
    }
    if (value.length <= 14) {
        return value;
    }
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
function isLocalhostSession() {
    const hostname = window.location.hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
function pause(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
function readStoredWalletId() {
    const stored = window.localStorage.getItem(WALLET_STORAGE_KEY);
    return WALLET_ORDER.includes(stored) ? stored : null;
}
function writeStoredWalletId(walletId) {
    if (!walletId) {
        window.localStorage.removeItem(WALLET_STORAGE_KEY);
        return;
    }
    window.localStorage.setItem(WALLET_STORAGE_KEY, walletId);
}
function pickWalletId(wallets, preferredId) {
    var _a, _b;
    if (preferredId && wallets.some((wallet) => wallet.id === preferredId)) {
        return preferredId;
    }
    return (_b = (_a = wallets[0]) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : null;
}
function useSolanaWallet() {
    var _a, _b, _c;
    const localhostMode = isLocalhostSession();
    const [availableWallets, setAvailableWallets] = (0, react_1.useState)([]);
    const [selectedWalletId, setSelectedWalletId] = (0, react_1.useState)(() => readStoredWalletId());
    const [publicKey, setPublicKey] = (0, react_1.useState)(null);
    const [connecting, setConnecting] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    (0, react_1.useEffect)(() => {
        const discovered = collectWallets();
        setAvailableWallets(discovered);
        setSelectedWalletId((current) => pickWalletId(discovered, current !== null && current !== void 0 ? current : readStoredWalletId()));
    }, []);
    const selectedWallet = (0, react_1.useMemo)(() => { var _a; return (_a = availableWallets.find((wallet) => wallet.id === selectedWalletId)) !== null && _a !== void 0 ? _a : null; }, [availableWallets, selectedWalletId]);
    const provider = (_a = selectedWallet === null || selectedWallet === void 0 ? void 0 : selectedWallet.provider) !== null && _a !== void 0 ? _a : null;
    (0, react_1.useEffect)(() => {
        writeStoredWalletId(selectedWalletId);
    }, [selectedWalletId]);
    (0, react_1.useEffect)(() => {
        var _a, _b, _c, _d;
        if (!provider) {
            setPublicKey(null);
            if (availableWallets.length === 0) {
                setError("No Solana wallet detected in this browser.");
            }
            return;
        }
        setPublicKey(localhostMode ? null : (_a = provider.publicKey) !== null && _a !== void 0 ? _a : null);
        setError(null);
        let cancelled = false;
        const syncPublicKey = (nextPublicKey) => {
            var _a;
            if (!cancelled) {
                setPublicKey((_a = nextPublicKey !== null && nextPublicKey !== void 0 ? nextPublicKey : provider.publicKey) !== null && _a !== void 0 ? _a : null);
            }
        };
        const handleDisconnect = () => {
            if (!cancelled) {
                setPublicKey(null);
            }
        };
        (_b = provider.on) === null || _b === void 0 ? void 0 : _b.call(provider, "connect", syncPublicKey);
        (_c = provider.on) === null || _c === void 0 ? void 0 : _c.call(provider, "accountChanged", syncPublicKey);
        (_d = provider.on) === null || _d === void 0 ? void 0 : _d.call(provider, "disconnect", handleDisconnect);
        if (!localhostMode) {
            void provider.connect({ onlyIfTrusted: true }).then((result) => {
                var _a, _b;
                if (!cancelled) {
                    setPublicKey((_b = (_a = result === null || result === void 0 ? void 0 : result.publicKey) !== null && _a !== void 0 ? _a : provider.publicKey) !== null && _b !== void 0 ? _b : null);
                }
            }).catch(() => {
                var _a;
                if (!cancelled) {
                    setPublicKey((_a = provider.publicKey) !== null && _a !== void 0 ? _a : null);
                }
            });
        }
        return () => {
            var _a, _b, _c;
            cancelled = true;
            (_a = provider.off) === null || _a === void 0 ? void 0 : _a.call(provider, "connect", syncPublicKey);
            (_b = provider.off) === null || _b === void 0 ? void 0 : _b.call(provider, "accountChanged", syncPublicKey);
            (_c = provider.off) === null || _c === void 0 ? void 0 : _c.call(provider, "disconnect", handleDisconnect);
        };
    }, [availableWallets.length, localhostMode, provider]);
    const connect = (0, react_1.useCallback)(() => __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
        const discovered = collectWallets();
        setAvailableWallets(discovered);
        const nextWalletId = pickWalletId(discovered, selectedWalletId !== null && selectedWalletId !== void 0 ? selectedWalletId : readStoredWalletId());
        const nextWallet = (_a = discovered.find((wallet) => wallet.id === nextWalletId)) !== null && _a !== void 0 ? _a : null;
        setSelectedWalletId(nextWalletId);
        if (!nextWallet) {
            setError("No Solana wallet detected. Open Brave Wallet or Phantom and try again.");
            return;
        }
        try {
            setConnecting(true);
            setError(null);
            const result = yield nextWallet.provider.connect();
            setPublicKey((_c = (_b = result === null || result === void 0 ? void 0 : result.publicKey) !== null && _b !== void 0 ? _b : nextWallet.provider.publicKey) !== null && _c !== void 0 ? _c : null);
        }
        catch (nextError) {
            setError(nextError.message);
        }
        finally {
            setConnecting(false);
        }
    }), [selectedWalletId]);
    const switchWallet = (0, react_1.useCallback)(() => __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
        const discovered = collectWallets();
        setAvailableWallets(discovered);
        const nextWalletId = pickWalletId(discovered, selectedWalletId !== null && selectedWalletId !== void 0 ? selectedWalletId : readStoredWalletId());
        const nextWallet = (_a = discovered.find((wallet) => wallet.id === nextWalletId)) !== null && _a !== void 0 ? _a : null;
        setSelectedWalletId(nextWalletId);
        if (!nextWallet) {
            setError("No Solana wallet detected. Open Brave Wallet or Phantom and try again.");
            return;
        }
        try {
            setConnecting(true);
            setError(null);
            if (nextWallet.provider.publicKey || nextWallet.provider.isConnected) {
                yield nextWallet.provider.disconnect().catch(() => undefined);
                setPublicKey(null);
                yield pause(150);
            }
            const result = yield nextWallet.provider.connect();
            setPublicKey((_c = (_b = result === null || result === void 0 ? void 0 : result.publicKey) !== null && _b !== void 0 ? _b : nextWallet.provider.publicKey) !== null && _c !== void 0 ? _c : null);
        }
        catch (nextError) {
            setError(nextError.message);
        }
        finally {
            setConnecting(false);
        }
    }), [selectedWalletId]);
    const selectWallet = (0, react_1.useCallback)((walletId) => __awaiter(this, void 0, void 0, function* () {
        if (walletId === selectedWalletId) {
            return;
        }
        if ((provider === null || provider === void 0 ? void 0 : provider.publicKey) || (provider === null || provider === void 0 ? void 0 : provider.isConnected)) {
            yield provider.disconnect().catch(() => undefined);
        }
        setPublicKey(null);
        setError(null);
        setSelectedWalletId(walletId);
    }), [provider, selectedWalletId]);
    const disconnect = (0, react_1.useCallback)(() => __awaiter(this, void 0, void 0, function* () {
        if (!provider) {
            return;
        }
        try {
            yield provider.disconnect();
            setPublicKey(null);
            setError(null);
        }
        catch (nextError) {
            setError(nextError.message);
        }
    }), [provider]);
    const address = (_b = publicKey === null || publicKey === void 0 ? void 0 : publicKey.toBase58()) !== null && _b !== void 0 ? _b : null;
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
        selectedWalletLabel: (_c = selectedWallet === null || selectedWallet === void 0 ? void 0 : selectedWallet.label) !== null && _c !== void 0 ? _c : null,
        error,
        connect,
        switchWallet,
        selectWallet,
        disconnect,
    };
}
