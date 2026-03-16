import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import {
  MAX_JOB_PAYLOAD_BYTES,
  MAX_JOB_TYPE_LENGTH,
  enqueueJobFromWallet,
  getPayloadByteLength,
  type Cluster,
  type EnqueueJobResult,
  type QueueView,
} from "./solana";
import type { SolanaWalletState } from "./useSolanaWallet";

const fieldStyle: CSSProperties = {
  width: "100%",
  background: "#0d0d0d",
  border: "1px solid #262626",
  color: "#d0d0d0",
  padding: "10px 12px",
  fontSize: 11,
  fontFamily: "'IBM Plex Mono', monospace",
  outline: "none",
};

const submitStyle: CSSProperties = {
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

interface CreateJobFormProps {
  cluster: Cluster;
  queue: QueueView | null;
  wallet: SolanaWalletState;
  onJobCreated(result: EnqueueJobResult): Promise<void> | void;
}

function shortAddress(value: string | null): string {
  if (!value) {
    return "-";
  }

  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function transactionUrl(cluster: Cluster, signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}

export default function CreateJobForm({
  cluster,
  queue,
  wallet,
  onJobCreated,
}: CreateJobFormProps) {
  const [jobType, setJobType] = useState("send-email");
  const [payloadText, setPayloadText] = useState(
    '{\n  "to": "user@example.com",\n  "subject": "Hello from SolQueue"\n}'
  );
  const [priority, setPriority] = useState<0 | 1 | 2>(1);
  const [delayMs, setDelayMs] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<EnqueueJobResult | null>(null);

  useEffect(() => {
    setError(null);
    setSuccess(null);
  }, [cluster, queue?.publicKey]);

  const payloadState = useMemo(() => {
    if (!payloadText.trim()) {
      return { parsed: null, bytes: 0, error: "Payload JSON is required." };
    }

    try {
      const parsed = JSON.parse(payloadText);
      return { parsed, bytes: getPayloadByteLength(parsed), error: null };
    } catch (nextError) {
      return { parsed: null, bytes: 0, error: (nextError as Error).message };
    }
  }, [payloadText]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
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

    if (normalizedJobType.length > MAX_JOB_TYPE_LENGTH) {
      setError(`Job type must be ${MAX_JOB_TYPE_LENGTH} characters or fewer.`);
      return;
    }

    if (payloadState.error || payloadState.parsed == null) {
      setError(`Invalid JSON payload: ${payloadState.error ?? "Unknown parse error."}`);
      return;
    }

    if (payloadState.bytes > MAX_JOB_PAYLOAD_BYTES) {
      setError(
        `Payload is ${payloadState.bytes} bytes. The on-chain limit is ${MAX_JOB_PAYLOAD_BYTES} bytes.`
      );
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

      const result = await enqueueJobFromWallet({
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
        await onJobCreated(result);
      } catch (refreshError) {
        setError(`Job created, but refreshing the dashboard failed: ${(refreshError as Error).message}`);
      }
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const walletLabel = wallet.connected ? shortAddress(wallet.address) : "NOT CONNECTED";
  const payloadLimitColor =
    payloadState.error != null
      ? "#fca5a5"
      : payloadState.bytes > MAX_JOB_PAYLOAD_BYTES
        ? "#fca5a5"
        : "#555";

  return (
    <div
      style={{
        borderBottom: "1px solid #141414",
        background: "linear-gradient(180deg, #080808 0%, #060606 100%)",
        padding: 20,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 18,
        }}
      >
        <div>
          <div style={{ color: "#3b82f6", fontSize: 10, letterSpacing: 2, marginBottom: 6, textTransform: "uppercase" }}>
            Create Job
          </div>
          <div style={{ color: "#8a8a8a", fontSize: 11, lineHeight: 1.8 }}>
            Queue writes happen directly from your wallet. The next job PDA is derived from the queue's live job counter.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ color: wallet.connected ? "#22c55e" : "#666", fontSize: 10, letterSpacing: 2 }}>
            WALLET {walletLabel}
          </div>
          {!wallet.connected ? (
            <button
              type="button"
              onClick={() => void wallet.connect()}
              disabled={wallet.connecting || !wallet.available}
              style={{
                ...submitStyle,
                background: wallet.available ? "#102012" : "transparent",
                borderColor: wallet.available ? "#22c55e" : "#333",
                color: wallet.available ? "#86efac" : "#555",
              }}
            >
              {wallet.connecting ? "CONNECTING" : "CONNECT WALLET"}
            </button>
          ) : null}
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <div>
            <div style={{ color: "#444", fontSize: 10, letterSpacing: 2, marginBottom: 8 }}>JOB TYPE</div>
            <input
              value={jobType}
              maxLength={MAX_JOB_TYPE_LENGTH}
              onChange={(event: any) => setJobType(event.target.value)}
              style={fieldStyle}
              placeholder="send-email"
            />
          </div>

          <div>
            <div style={{ color: "#444", fontSize: 10, letterSpacing: 2, marginBottom: 8 }}>PRIORITY</div>
            <select
              value={priority}
              onChange={(event: any) => setPriority(Number(event.target.value) as 0 | 1 | 2)}
              style={fieldStyle}
            >
              <option value={0}>0 = low</option>
              <option value={1}>1 = normal</option>
              <option value={2}>2 = high</option>
            </select>
          </div>

          <div>
            <div style={{ color: "#444", fontSize: 10, letterSpacing: 2, marginBottom: 8 }}>DELAY (MS)</div>
            <input
              value={delayMs}
              onChange={(event: any) => setDelayMs(event.target.value)}
              style={fieldStyle}
              inputMode="numeric"
              placeholder="0"
            />
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 8, flexWrap: "wrap" }}>
            <span style={{ color: "#444", fontSize: 10, letterSpacing: 2 }}>PAYLOAD (JSON)</span>
            <span style={{ color: payloadLimitColor, fontSize: 10 }}>
              {payloadState.error ? payloadState.error : `${payloadState.bytes} / ${MAX_JOB_PAYLOAD_BYTES} bytes`}
            </span>
          </div>
          <textarea
            value={payloadText}
            onChange={(event: any) => setPayloadText(event.target.value)}
            style={{
              ...fieldStyle,
              minHeight: 128,
              resize: "vertical",
              lineHeight: 1.7,
              whiteSpace: "pre",
            }}
            spellCheck={false}
          />
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
            marginTop: 16,
          }}
        >
          <div style={{ color: queue?.paused ? "#fca5a5" : "#555", fontSize: 10, lineHeight: 1.8 }}>
            <div>Queue: {queue?.name ?? "not loaded"}</div>
            <div>{queue?.paused ? "Queue is paused and will reject new jobs." : "Writes are signed by the connected wallet."}</div>
          </div>

          <button
            type="submit"
            disabled={submitting || !queue || queue.paused}
            style={{
              ...submitStyle,
              opacity: submitting || !queue || queue.paused ? 0.5 : 1,
              cursor: submitting || !queue || queue.paused ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "ENQUEUING" : "ENQUEUE JOB"}
          </button>
        </div>
      </form>

      {error ? (
        <div
          style={{
            marginTop: 14,
            color: "#fca5a5",
            background: "#1f0e0e",
            border: "1px solid #3a1e1e",
            padding: "10px 12px",
            fontSize: 11,
            lineHeight: 1.7,
          }}
        >
          {error}
        </div>
      ) : null}

      {success ? (
        <div
          style={{
            marginTop: 14,
            background: "#0d1f0e",
            border: "1px solid #1f4d27",
            color: "#86efac",
            padding: "12px 14px",
            fontSize: 11,
            lineHeight: 1.8,
          }}
        >
          <div>Job #{success.jobId} enqueued successfully.</div>
          <div>Job PDA: {success.jobPda}</div>
          <div>Payload: {success.payloadBytes} bytes</div>
          {cluster === "localnet" ? (
            <div>Signature: {success.signature}</div>
          ) : (
            <a
              href={transactionUrl(cluster, success.signature)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#bbf7d0", textDecoration: "none" }}
            >
              View transaction on explorer
            </a>
          )}
        </div>
      ) : null}
    </div>
  );
}
