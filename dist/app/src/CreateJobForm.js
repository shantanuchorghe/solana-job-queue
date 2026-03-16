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
exports.default = CreateJobForm;
const react_1 = require("react");
const solana_1 = require("./solana");
const fieldStyle = {
    width: "100%",
    background: "#0d0d0d",
    border: "1px solid #262626",
    color: "#d0d0d0",
    padding: "10px 12px",
    fontSize: 11,
    fontFamily: "'IBM Plex Mono', monospace",
    outline: "none",
};
const submitStyle = {
    background: "#0d2040",
    border: "1px solid #3b82f6",
    color: "#93c5fd",
    cursor: "pointer",
    padding: "11px 18px",
    fontSize: 10,
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "'IBM Plex Mono', monospace",
};
function shortAddress(value) {
    if (!value) {
        return "-";
    }
    if (value.length <= 16) {
        return value;
    }
    return `${value.slice(0, 6)}...${value.slice(-6)}`;
}
function transactionUrl(cluster, signature) {
    return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}
function CreateJobForm({ cluster, queue, wallet, onJobCreated, }) {
    var _a, _b, _c;
    const [jobType, setJobType] = (0, react_1.useState)("send-email");
    const [payloadText, setPayloadText] = (0, react_1.useState)('{\n  "to": "user@example.com",\n  "subject": "Hello from DecQueue"\n}');
    const [priority, setPriority] = (0, react_1.useState)(1);
    const [delayMs, setDelayMs] = (0, react_1.useState)("0");
    const [submitting, setSubmitting] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    const [success, setSuccess] = (0, react_1.useState)(null);
    (0, react_1.useEffect)(() => {
        setError(null);
        setSuccess(null);
    }, [cluster, queue === null || queue === void 0 ? void 0 : queue.publicKey]);
    const payloadState = (0, react_1.useMemo)(() => {
        if (!payloadText.trim()) {
            return { parsed: null, bytes: 0, error: "Payload JSON is required." };
        }
        try {
            const parsed = JSON.parse(payloadText);
            return { parsed, bytes: (0, solana_1.getPayloadByteLength)(parsed), error: null };
        }
        catch (nextError) {
            return { parsed: null, bytes: 0, error: nextError.message };
        }
    }, [payloadText]);
    function handleSubmit(event) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            event.preventDefault();
            if (!queue) {
                setError("Load a queue before enqueuing a job.");
                return;
            }
            if (!wallet.provider || !wallet.connected) {
                setError("Connect your wallet before enqueuing a job.");
                return;
            }
            const normalizedJobType = jobType.trim();
            if (!normalizedJobType) {
                setError("Job type is required.");
                return;
            }
            if (normalizedJobType.length > solana_1.MAX_JOB_TYPE_LENGTH) {
                setError(`Job type must be ${solana_1.MAX_JOB_TYPE_LENGTH} characters or fewer.`);
                return;
            }
            if (payloadState.error || payloadState.parsed == null) {
                setError(`Invalid JSON payload: ${(_a = payloadState.error) !== null && _a !== void 0 ? _a : "Unknown parse error."}`);
                return;
            }
            if (payloadState.bytes > solana_1.MAX_JOB_PAYLOAD_BYTES) {
                setError(`Payload is ${payloadState.bytes} bytes. The on-chain limit is ${solana_1.MAX_JOB_PAYLOAD_BYTES} bytes.`);
                return;
            }
            const delayValue = Number(delayMs);
            if (!Number.isFinite(delayValue) || delayValue < 0) {
                setError("Delay must be zero or greater.");
                return;
            }
            try {
                setSubmitting(true);
                setError(null);
                const result = yield (0, solana_1.enqueueJobFromWallet)({
                    cluster,
                    queueAddress: queue.publicKey,
                    wallet: wallet.provider,
                    jobType: normalizedJobType,
                    payload: payloadState.parsed,
                    priority,
                    delay: Math.floor(delayValue),
                });
                setSuccess(result);
                try {
                    yield onJobCreated(result);
                }
                catch (refreshError) {
                    setError(`Job created, but refreshing the dashboard failed: ${refreshError.message}`);
                }
            }
            catch (nextError) {
                setError(nextError.message);
            }
            finally {
                setSubmitting(false);
            }
        });
    }
    const walletLabel = wallet.connected ? shortAddress(wallet.address) : "NOT CONNECTED";
    const payloadLimitColor = payloadState.error != null
        ? "#fca5a5"
        : payloadState.bytes > solana_1.MAX_JOB_PAYLOAD_BYTES
            ? "#fca5a5"
            : "#555";
    return (<div style={{
            borderBottom: "1px solid #141414",
            background: "linear-gradient(180deg, #080808 0%, #060606 100%)",
            padding: 20,
        }}>
      <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 18,
        }}>
        <div>
          <div style={{ color: "#3b82f6", fontSize: 10, letterSpacing: 2, marginBottom: 6, textTransform: "uppercase" }}>
            Create Job
          </div>
          <div style={{ color: "#8a8a8a", fontSize: 11, lineHeight: 1.8 }}>
            Queue writes happen directly from your wallet. The next job PDA is derived from the queue's live job counter.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {wallet.availableWallets.length > 1 ? (<select value={(_a = wallet.selectedWalletId) !== null && _a !== void 0 ? _a : ""} onChange={(event) => void wallet.selectWallet(event.target.value)} style={Object.assign(Object.assign({}, fieldStyle), { width: 130, padding: "9px 12px" })}>
              {wallet.availableWallets.map((walletOption) => (<option key={walletOption.id} value={walletOption.id}>
                  {walletOption.label}
                </option>))}
            </select>) : null}
          <div style={{ color: wallet.connected ? "#22c55e" : "#666", fontSize: 10, letterSpacing: 2 }}>
            {wallet.selectedWalletLabel ? `${wallet.selectedWalletLabel.toUpperCase()} ` : ""}WALLET {walletLabel}
          </div>
          {!wallet.connected ? (<button type="button" onClick={() => void wallet.connect()} disabled={wallet.connecting || !wallet.available} style={Object.assign(Object.assign({}, submitStyle), { background: wallet.available ? "#102012" : "transparent", borderColor: wallet.available ? "#22c55e" : "#333", color: wallet.available ? "#86efac" : "#555" })}>
              {wallet.connecting ? "CONNECTING" : `CONNECT ${(_b = wallet.selectedWalletLabel) !== null && _b !== void 0 ? _b : "WALLET"}`}
            </button>) : (<button type="button" onClick={() => void wallet.switchWallet()} disabled={wallet.connecting || !wallet.available} style={Object.assign(Object.assign({}, submitStyle), { background: wallet.available ? "#231707" : "transparent", borderColor: wallet.available ? "#f59e0b" : "#333", color: wallet.available ? "#fcd34d" : "#555" })}>
              {wallet.connecting ? "SWITCHING" : "SWITCH ACCOUNT"}
            </button>)}
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <div>
            <div style={{ color: "#444", fontSize: 10, letterSpacing: 2, marginBottom: 8 }}>JOB TYPE</div>
            <input value={jobType} maxLength={solana_1.MAX_JOB_TYPE_LENGTH} onChange={(event) => setJobType(event.target.value)} style={fieldStyle} placeholder="send-email"/>
          </div>

          <div>
            <div style={{ color: "#444", fontSize: 10, letterSpacing: 2, marginBottom: 8 }}>PRIORITY</div>
            <select value={priority} onChange={(event) => setPriority(Number(event.target.value))} style={fieldStyle}>
              <option value={0}>0 = low</option>
              <option value={1}>1 = normal</option>
              <option value={2}>2 = high</option>
            </select>
          </div>

          <div>
            <div style={{ color: "#444", fontSize: 10, letterSpacing: 2, marginBottom: 8 }}>DELAY (MS)</div>
            <input value={delayMs} onChange={(event) => setDelayMs(event.target.value)} style={fieldStyle} inputMode="numeric" placeholder="0"/>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 8, flexWrap: "wrap" }}>
            <span style={{ color: "#444", fontSize: 10, letterSpacing: 2 }}>PAYLOAD (JSON)</span>
            <span style={{ color: payloadLimitColor, fontSize: 10 }}>
              {payloadState.error ? payloadState.error : `${payloadState.bytes} / ${solana_1.MAX_JOB_PAYLOAD_BYTES} bytes`}
            </span>
          </div>
          <textarea value={payloadText} onChange={(event) => setPayloadText(event.target.value)} style={Object.assign(Object.assign({}, fieldStyle), { minHeight: 128, resize: "vertical", lineHeight: 1.7, whiteSpace: "pre" })} spellCheck={false}/>
        </div>

        <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
            marginTop: 16,
        }}>
          <div style={{ color: (queue === null || queue === void 0 ? void 0 : queue.paused) ? "#fca5a5" : "#555", fontSize: 10, lineHeight: 1.8 }}>
            <div>Queue: {(_c = queue === null || queue === void 0 ? void 0 : queue.name) !== null && _c !== void 0 ? _c : "not loaded"}</div>
            <div>
              {(queue === null || queue === void 0 ? void 0 : queue.paused)
            ? "Queue is paused and will reject new jobs."
            : wallet.localhostMode
                ? "On localhost, pick Phantom or Brave explicitly, then use switch account if you need a different address inside that wallet."
                : "Writes are signed by the connected wallet."}
            </div>
          </div>

          <button type="submit" disabled={submitting || !queue || queue.paused} style={Object.assign(Object.assign({}, submitStyle), { opacity: submitting || !queue || queue.paused ? 0.5 : 1, cursor: submitting || !queue || queue.paused ? "not-allowed" : "pointer" })}>
            {submitting ? "ENQUEUING" : "ENQUEUE JOB"}
          </button>
        </div>
      </form>

      {error ? (<div style={{
                marginTop: 14,
                color: "#fca5a5",
                background: "#1f0e0e",
                border: "1px solid #3a1e1e",
                padding: "10px 12px",
                fontSize: 11,
                lineHeight: 1.7,
            }}>
          {error}
        </div>) : null}

      {success ? (<div style={{
                marginTop: 14,
                background: "#0d1f0e",
                border: "1px solid #1f4d27",
                color: "#86efac",
                padding: "12px 14px",
                fontSize: 11,
                lineHeight: 1.8,
            }}>
          <div>Job #{success.jobId} enqueued successfully.</div>
          <div>Job PDA: {success.jobPda}</div>
          <div>Payload: {success.payloadBytes} bytes</div>
          {cluster === "localnet" ? (<div>Signature: {success.signature}</div>) : (<a href={transactionUrl(cluster, success.signature)} target="_blank" rel="noopener noreferrer" style={{ color: "#bbf7d0", textDecoration: "none" }}>
              View transaction on explorer
            </a>)}
        </div>) : null}
    </div>);
}
