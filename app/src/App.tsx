import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import CreateJobForm from "./CreateJobForm";
import {
  fetchQueueSnapshot,
  getProgramId,
  subscribeToQueueEvents,
  cancelJobFromWallet,
  type Cluster,
  type EnqueueJobResult,
  type JobStatus,
  type JobView,
  type LiveEvent,
  type QueueSnapshot,
} from "./solana";
import { useSolanaWallet } from "./useSolanaWallet";

const DEFAULT_QUEUE = import.meta.env.VITE_DECQUEUE_DEFAULT_QUEUE ?? "";
const AUTO_REFRESH_MS = 15000;

const STATUS_COLORS: Record<JobStatus, { bg: string; accent: string; text: string; dot: string }> = {
  pending: { bg: "#1a1f2e", accent: "#3b82f6", text: "#93c5fd", dot: "#3b82f6" },
  processing: { bg: "#1f1a0e", accent: "#f59e0b", text: "#fcd34d", dot: "#f59e0b" },
  completed: { bg: "#0e1f14", accent: "#22c55e", text: "#86efac", dot: "#22c55e" },
  failed: { bg: "#1f0e0e", accent: "#ef4444", text: "#fca5a5", dot: "#ef4444" },
  cancelled: { bg: "#161616", accent: "#6b7280", text: "#9ca3af", dot: "#6b7280" },
};

const PRIORITY_LABELS = { 0: "LOW", 1: "NORMAL", 2: "HIGH" } as const;
const PRIORITY_COLORS = { 0: "#6b7280", 1: "#3b82f6", 2: "#f59e0b" } as const;
const STATUS_FILTERS = ["all", "pending", "processing", "completed", "failed", "cancelled"] as const;

function truncate(value: string, head = 8, tail = 4): string {
  if (value.length <= head + tail + 3) {
    return value;
  }

  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function formatAgo(date: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`;
  }

  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)}h ago`;
  }

  return `${Math.round(seconds / 86400)}d ago`;
}

function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function statusCount(snapshot: QueueSnapshot | null, filter: typeof STATUS_FILTERS[number]): number {
  if (!snapshot) {
    return 0;
  }

  if (filter === "all") {
    return snapshot.jobs.length;
  }

  return snapshot.jobs.filter((job) => job.status === filter).length;
}

function StatCard({
  label,
  value,
  accent,
  sublabel,
}: {
  label: string;
  value: number | string;
  accent: string;
  sublabel?: string;
}) {
  return (
    <div
      style={{
        background: "#0d0d0d",
        border: `1px solid ${accent}30`,
        borderTop: `2px solid ${accent}`,
        padding: "20px 24px",
        fontFamily: "'IBM Plex Mono', monospace",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: 60,
          height: 60,
          background: `${accent}08`,
          borderRadius: "0 0 0 60px",
        }}
      />
      <div style={{ color: "#444", fontSize: 10, letterSpacing: 3, textTransform: "uppercase", marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ color: accent, fontSize: 32, fontWeight: 700, lineHeight: 1, letterSpacing: -1 }}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {sublabel ? <div style={{ color: "#555", fontSize: 10, marginTop: 8 }}>{sublabel}</div> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: JobStatus }) {
  const colors = STATUS_COLORS[status];
  return (
    <span
      style={{
        background: colors.bg,
        color: colors.text,
        border: `1px solid ${colors.accent}40`,
        fontSize: 9,
        letterSpacing: 2,
        padding: "3px 8px",
        textTransform: "uppercase",
        fontFamily: "'IBM Plex Mono', monospace",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: colors.dot,
          display: "inline-block",
          boxShadow: status === "processing" ? `0 0 6px ${colors.dot}` : "none",
          animation: status === "processing" ? "pulse 1.5s ease-in-out infinite" : "none",
        }}
      />
      {status}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: 0 | 1 | 2 }) {
  return (
    <span
      style={{
        color: PRIORITY_COLORS[priority],
        fontSize: 9,
        letterSpacing: 2,
        fontFamily: "'IBM Plex Mono', monospace",
        fontWeight: 700,
      }}
    >
      ^ {PRIORITY_LABELS[priority]}
    </span>
  );
}

function JobRow({
  job,
  onClick,
  selected,
  onCancel,
  isCancelling,
}: {
  job: JobView;
  onClick: () => void;
  selected: boolean;
  onCancel?: (job: JobView) => void;
  isCancelling?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr 110px 80px 90px 70px 60px",
        gap: 16,
        padding: "10px 16px",
        borderBottom: "1px solid #1a1a1a",
        cursor: "pointer",
        background: selected ? "#161616" : "transparent",
        borderLeft: selected ? "2px solid #3b82f6" : "2px solid transparent",
        transition: "all 0.1s",
        alignItems: "center",
      }}
      onMouseEnter={(event: any) => {
        if (!selected) {
          event.currentTarget.style.background = "#0f0f0f";
        }
      }}
      onMouseLeave={(event: any) => {
        if (!selected) {
          event.currentTarget.style.background = "transparent";
        }
      }}
    >
      <span style={{ color: "#444", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 }}>
        #{job.jobId.toString().padStart(4, "0")}
      </span>
      <span
        style={{
          color: "#c8c8c8",
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 11,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {job.jobType}
      </span>
      <StatusBadge status={job.status} />
      <PriorityBadge priority={job.priority} />
      <span style={{ color: "#444", fontFamily: "'IBM Plex Mono', monospace", fontSize: 10 }}>
        {job.attempts}/{job.maxRetries}
      </span>
      <span style={{ color: "#444", fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, textAlign: "right" }}>
        {formatAgo(job.createdAt)}
      </span>
      <span style={{ textAlign: "right" }}>
        {(job.status === "pending" || job.status === "processing") ? (
          <button
            onClick={(e: any) => {
              e.stopPropagation();
              onCancel?.(job);
            }}
            disabled={isCancelling}
            style={{
              background: "transparent",
              border: "1px solid #333",
              color: isCancelling ? "#666" : "#ef4444",
              cursor: isCancelling ? "default" : "pointer",
              padding: "4px 8px",
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 9,
              letterSpacing: 1,
            }}
          >
            {isCancelling ? <span className="spinner" /> : "CANCEL"}
          </button>
        ) : null}
      </span>
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ borderBottom: "1px solid #1a1a1a", padding: "10px 0", display: "flex", gap: 16 }}>
      <span style={{ color: "#444", fontSize: 10, letterSpacing: 2, width: 90, flexShrink: 0 }}>{label}</span>
      <span style={{ color: "#888", fontSize: 11, wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

function JobDetail({ job, onClose }: { job: JobView; onClose: () => void }) {
  const colors = STATUS_COLORS[job.status];
  const payloadText =
    typeof job.payload === "string" ? job.payload : JSON.stringify(job.payload, null, 2);

  return (
    <div
      style={{
        background: "#0a0a0a",
        border: "1px solid #222",
        borderLeft: `3px solid ${colors.accent}`,
        padding: 24,
        fontFamily: "'IBM Plex Mono', monospace",
        height: "100%",
        overflow: "auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <span style={{ color: "#666", fontSize: 11, letterSpacing: 2, textTransform: "uppercase" }}>
          JOB #{job.jobId.toString().padStart(4, "0")}
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "1px solid #333",
            color: "#666",
            cursor: "pointer",
            padding: "4px 10px",
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11,
          }}
        >
          CLOSE
        </button>
      </div>

      <div style={{ marginBottom: 20 }}>
        <div style={{ color: colors.text, fontSize: 20, fontWeight: 700, marginBottom: 8 }}>{job.jobType}</div>
        <StatusBadge status={job.status} />
      </div>

      <FieldRow label="PRIORITY" value={PRIORITY_LABELS[job.priority]} />
      <FieldRow label="ATTEMPTS" value={`${job.attempts} / ${job.maxRetries}`} />
      <FieldRow label="CREATED" value={job.createdAt.toISOString()} />
      <FieldRow label="READY AT" value={job.executeAfter.toISOString()} />
      <FieldRow label="WORKER" value={job.worker ?? "-"} />
      <FieldRow label="PDA" value={job.publicKey} />

      <div style={{ marginTop: 16 }}>
        <div style={{ color: "#444", fontSize: 10, letterSpacing: 2, marginBottom: 8 }}>PAYLOAD</div>
        <pre
          style={{
            background: "#0d0d0d",
            border: "1px solid #1e1e1e",
            color: "#6bff9e",
            padding: 12,
            fontSize: 10,
            overflow: "auto",
            margin: 0,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {payloadText}
        </pre>
      </div>

      {job.result ? (
        <div style={{ marginTop: 16 }}>
          <div style={{ color: "#444", fontSize: 10, letterSpacing: 2, marginBottom: 8 }}>RESULT</div>
          <pre
            style={{
              background: "#0d1f0e",
              border: "1px solid #1e3a1e",
              color: "#86efac",
              padding: 12,
              fontSize: 10,
              overflow: "auto",
              margin: 0,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {job.result}
          </pre>
        </div>
      ) : null}

      {job.errorMessage ? (
        <div style={{ marginTop: 16 }}>
          <div style={{ color: "#ef4444", fontSize: 10, letterSpacing: 2, marginBottom: 8 }}>ERROR</div>
          <div
            style={{
              background: "#1f0e0e",
              border: "1px solid #3a1e1e",
              color: "#fca5a5",
              padding: 12,
              fontSize: 11,
              whiteSpace: "pre-wrap",
            }}
          >
            {job.errorMessage}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({
  queueInput,
  onUseDefault,
}: {
  queueInput: string;
  onUseDefault: () => void;
}) {
  return (
    <div
      style={{
        margin: "48px auto",
        maxWidth: 820,
        border: "1px solid #1e1e1e",
        background: "linear-gradient(180deg, #0a0a0a 0%, #070707 100%)",
        padding: 32,
      }}
    >
      <div style={{ color: "#3b82f6", fontSize: 12, letterSpacing: 3, textTransform: "uppercase", marginBottom: 12 }}>
        Devnet MVP
      </div>
      <div style={{ color: "#f4f4f4", fontSize: 28, lineHeight: 1.2, maxWidth: 540, marginBottom: 16 }}>
        Load a real queue PDA to turn this dashboard from prototype into a live Solana monitor.
      </div>
      <div style={{ color: "#6a6a6a", fontSize: 12, lineHeight: 1.8, maxWidth: 620, marginBottom: 24 }}>
        This MVP reads queue and job accounts directly from devnet or localnet. Once a queue is loaded, you can enqueue jobs from the dashboard with your wallet and watch workers process them live.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 1, background: "#141414" }}>
        <StatCard label="Program" value={truncate(getProgramId(), 8, 6)} accent="#3b82f6" sublabel="same program id on localnet/devnet" />
        <StatCard label="Write Path" value="WALLET TX" accent="#f59e0b" sublabel="enqueue from the dashboard" />
        <StatCard label="Read Path" value="LIVE RPC" accent="#22c55e" sublabel="queue and jobs come from chain" />
        <StatCard label="Queue Input" value={queueInput ? "READY" : "MISSING"} accent={queueInput ? "#22c55e" : "#ef4444"} sublabel="paste queue PDA above" />
      </div>

      <div style={{ marginTop: 24, padding: 16, background: "#0d0d0d", border: "1px solid #1a1a1a", color: "#5f5f5f", fontSize: 11, lineHeight: 1.8 }}>
        <div>1. Deploy the program on devnet.</div>
        <div>2. Connect a Solana wallet in the dashboard.</div>
        <div>3. Paste a queue PDA and enqueue a job from the form.</div>
        <div>4. Run the worker to process it live.</div>
      </div>

      {DEFAULT_QUEUE ? (
        <button
          onClick={onUseDefault}
          style={{
            marginTop: 20,
            background: "#0d2040",
            border: "1px solid #3b82f6",
            color: "#3b82f6",
            cursor: "pointer",
            padding: "10px 16px",
            fontSize: 10,
            letterSpacing: 2,
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          LOAD DEFAULT QUEUE
        </button>
      ) : null}
    </div>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  background: "#0d0d0d",
  border: "1px solid #2a2a2a",
  color: "#c8c8c8",
  padding: "10px 12px",
  fontSize: 11,
  fontFamily: "'IBM Plex Mono', monospace",
  outline: "none",
  boxSizing: "border-box",
};

const buttonStyle: CSSProperties = {
  background: "transparent",
  border: "1px solid #333",
  color: "#666",
  cursor: "pointer",
  padding: "9px 14px",
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10,
  letterSpacing: 2,
  textTransform: "uppercase",
};

export default function App() {
  const [cluster, setCluster] = useState<Cluster>("devnet");
  const [queueInput, setQueueInput] = useState(DEFAULT_QUEUE);
  const [activeQueue, setActiveQueue] = useState(DEFAULT_QUEUE);
  const [filter, setFilter] = useState<typeof STATUS_FILTERS[number]>("all");
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [selectedJobKey, setSelectedJobKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancellingJobIds, setCancellingJobIds] = useState<Set<string>>(new Set());
  const wallet = useSolanaWallet();

  const refreshQueue = useCallback(
    async (quiet = false) => {
      if (!activeQueue) {
        return;
      }

      try {
        if (!quiet) {
          setLoading(true);
        }
        setError(null);
        const nextSnapshot = await fetchQueueSnapshot(cluster, activeQueue);
        setSnapshot(nextSnapshot);
      } catch (nextError) {
        setError((nextError as Error).message);
      } finally {
        if (!quiet) {
          setLoading(false);
        }
      }
    },
    [activeQueue, cluster]
  );

  useEffect(() => {
    if (!activeQueue) {
      return;
    }

    void refreshQueue();
  }, [activeQueue, cluster, refreshQueue]);

  useEffect(() => {
    if (!activeQueue) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshQueue(true);
    }, AUTO_REFRESH_MS);

    return () => window.clearInterval(intervalId);
  }, [activeQueue, refreshQueue]);

  useEffect(() => {
    if (!activeQueue) {
      setEvents([]);
      return;
    }

    setEvents([
      {
        id: `watch-${cluster}-${activeQueue}`,
        text: `WATCHING ${cluster.toUpperCase()} FOR ${truncate(activeQueue, 12, 8)}`,
        timestamp: new Date(),
        kind: "system",
      },
    ]);

    let removeListeners: (() => Promise<void>) | null = null;
    void subscribeToQueueEvents(cluster, activeQueue, (event) => {
      setEvents((previous) => [event, ...previous].slice(0, 10));
      void refreshQueue(true);
    }).then((cleanup) => {
      removeListeners = cleanup;
    }).catch((eventError) => {
      setEvents((previous) => [
        {
          id: `event-error-${Date.now()}`,
          text: `EVENT STREAM UNAVAILABLE: ${(eventError as Error).message}`,
          timestamp: new Date(),
          kind: "system" as const,
        },
        ...previous,
      ].slice(0, 10));
    });

    return () => {
      if (removeListeners) {
        void removeListeners();
      }
    };
  }, [activeQueue, cluster, refreshQueue]);

  const filteredJobs = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    return filter === "all" ? snapshot.jobs : snapshot.jobs.filter((job) => job.status === filter);
  }, [filter, snapshot]);

  const selectedJob = useMemo(
    () => snapshot?.jobs.find((job) => job.publicKey === selectedJobKey) ?? null,
    [selectedJobKey, snapshot]
  );

  const successRate = snapshot && snapshot.queue.totalJobs > 0
    ? ((snapshot.queue.completedJobs / snapshot.queue.totalJobs) * 100).toFixed(1)
    : "0.0";

  function handleLoadQueue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelectedJobKey(null);
    setActiveQueue(queueInput.trim());
  }

  const handleJobCreated = useCallback(
    async (result: EnqueueJobResult) => {
      setSelectedJobKey(result.jobPda);
      setEvents((previous) => [
        {
          id: `job-created-${result.jobId}-${Date.now()}`,
          text: `JOB #${result.jobId} ENQUEUED FROM ${wallet.shortAddress ?? "WALLET"}`,
          timestamp: new Date(),
          kind: "system" as const,
        },
        ...previous,
      ].slice(0, 10));
      await refreshQueue(true);
    },
    [refreshQueue, wallet.shortAddress]
  );

  const handleCancelJob = useCallback(
    async (job: Pick<JobView, "publicKey" | "jobId">) => {
      if (!wallet.publicKey) {
        return alert("Wallet not connected");
      }
      setCancellingJobIds((prev) => new Set(prev).add(job.publicKey));
      try {
        await cancelJobFromWallet({
          cluster,
          queueAddress: activeQueue,
          wallet: wallet.provider,
          jobAddress: job.publicKey,
        });
        await refreshQueue(true);
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setCancellingJobIds((prev) => {
          const next = new Set(prev);
          next.delete(job.publicKey);
          return next;
        });
      }
    },
    [cluster, activeQueue, wallet, refreshQueue]
  );

  return (
    <div
      style={{
        background: "#060606",
        minHeight: "100vh",
        color: "#c8c8c8",
        fontFamily: "'IBM Plex Mono', monospace",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; background: #0a0a0a; }
        ::-webkit-scrollbar-thumb { background: #333; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div
        style={{
          borderBottom: "1px solid #1a1a1a",
          padding: "0 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 72,
          background: "#080808",
          gap: 20,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ color: "#3b82f6", fontSize: 14, fontWeight: 700, letterSpacing: -0.5 }}>DECQUEUE</div>
          <div style={{ width: 1, height: 20, background: "#1e1e1e" }} />
          <div style={{ color: "#444", fontSize: 10, letterSpacing: 2 }}>ON-CHAIN JOB QUEUE</div>
          <div style={{ width: 1, height: 20, background: "#1e1e1e" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: cluster === "devnet" ? "#22c55e" : "#f59e0b",
                display: "inline-block",
                boxShadow: cluster === "devnet" ? "0 0 6px #22c55e" : "0 0 6px #f59e0b",
                animation: "pulse 2s ease-in-out infinite",
              }}
            />
            <span style={{ color: cluster === "devnet" ? "#22c55e" : "#f59e0b", fontSize: 9, letterSpacing: 2 }}>
              {cluster.toUpperCase()}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {wallet.availableWallets.length > 1 ? (
            <select
              value={wallet.selectedWalletId ?? ""}
              onChange={(event: any) => void wallet.selectWallet(event.target.value)}
              style={{ ...inputStyle, width: 140, padding: "9px 12px" }}
            >
              {wallet.availableWallets.map((walletOption) => (
                <option key={walletOption.id} value={walletOption.id}>
                  {walletOption.label}
                </option>
              ))}
            </select>
          ) : wallet.selectedWalletLabel ? (
            <div style={{ color: "#555", fontSize: 10 }}>
              APP: <span style={{ color: "#777" }}>{wallet.selectedWalletLabel}</span>
            </div>
          ) : null}
          <div style={{ color: wallet.connected ? "#22c55e" : "#555", fontSize: 10 }}>
            WALLET: <span style={{ color: wallet.connected ? "#86efac" : "#777" }}>{wallet.shortAddress ?? "DISCONNECTED"}</span>
          </div>
          {wallet.connected ? (
            <>
              <button
                onClick={() => void wallet.switchWallet()}
                disabled={wallet.connecting || !wallet.available}
                style={{
                  ...buttonStyle,
                  color: wallet.available ? "#f59e0b" : "#444",
                  borderColor: wallet.available ? "#f59e0b" : "#222",
                }}
              >
                {wallet.connecting ? "SWITCHING" : "SWITCH ACCOUNT"}
              </button>
              <button
                onClick={() => void wallet.disconnect()}
                disabled={wallet.connecting}
                style={{
                  ...buttonStyle,
                  color: "#86efac",
                  borderColor: "#22c55e",
                }}
              >
                DISCONNECT
              </button>
            </>
          ) : (
            <button
              onClick={() => void wallet.connect()}
              disabled={wallet.connecting || !wallet.available}
              style={{
                ...buttonStyle,
                color: wallet.available ? "#3b82f6" : "#444",
                borderColor: wallet.available ? "#3b82f6" : "#222",
              }}
            >
              {wallet.connecting ? "CONNECTING" : `CONNECT ${wallet.selectedWalletLabel ?? "WALLET"}`}
            </button>
          )}
          <div style={{ color: "#333", fontSize: 10 }}>
            PROGRAM: <span style={{ color: "#555" }}>{truncate(getProgramId(), 8, 8)}</span>
          </div>
          <button
            onClick={() => void refreshQueue()}
            disabled={!activeQueue || loading}
            style={{
              ...buttonStyle,
              color: activeQueue ? "#3b82f6" : "#444",
              borderColor: activeQueue ? "#3b82f6" : "#222",
            }}
          >
            {loading ? "LOADING" : "REFRESH"}
          </button>
        </div>
      </div>

      <div style={{ padding: "18px 24px", borderBottom: "1px solid #141414", background: "#070707" }}>
        <form onSubmit={handleLoadQueue} style={{ display: "grid", gridTemplateColumns: "120px 1fr 140px 120px", gap: 12 }}>
          <select value={cluster} onChange={(event: any) => setCluster(event.target.value as Cluster)} style={inputStyle}>
            <option value="devnet">devnet</option>
            <option value="localnet">localnet</option>
          </select>
          <input
            value={queueInput}
            onChange={(event: any) => setQueueInput(event.target.value)}
            style={inputStyle}
            placeholder="Paste queue PDA"
          />
          <button
            type="submit"
            style={{
              ...buttonStyle,
              background: "#0d2040",
              borderColor: "#3b82f6",
              color: "#3b82f6",
            }}
          >
            LOAD QUEUE
          </button>
          <button
            type="button"
            onClick={() => {
              setQueueInput(DEFAULT_QUEUE);
              setActiveQueue(DEFAULT_QUEUE);
            }}
            style={buttonStyle}
          >
            USE DEFAULT
          </button>
        </form>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginTop: 12, color: "#444", fontSize: 10, flexWrap: "wrap" }}>
          <span>Auto refresh every {AUTO_REFRESH_MS / 1000}s</span>
          <span>
            {wallet.localhostMode
              ? "Localhost mode disables silent reconnect. Pick Phantom or Brave explicitly before connecting."
              : "Reads use RPC. New jobs are created with wallet-signed transactions."}
          </span>
        </div>

        {error ? (
          <div style={{ marginTop: 12, color: "#fca5a5", background: "#1f0e0e", border: "1px solid #3a1e1e", padding: "10px 12px", fontSize: 11 }}>
            {error}
          </div>
        ) : null}

        {wallet.error ? (
          <div style={{ marginTop: 12, color: "#fcd34d", background: "#1f1a0e", border: "1px solid #4b3a12", padding: "10px 12px", fontSize: 11 }}>
            {wallet.error}
          </div>
        ) : null}
      </div>

      {!snapshot ? (
        <EmptyState
          queueInput={queueInput}
          onUseDefault={() => {
            setQueueInput(DEFAULT_QUEUE);
            setActiveQueue(DEFAULT_QUEUE);
          }}
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", minHeight: "calc(100vh - 152px)" }}>
          <div style={{ borderRight: "1px solid #141414", background: "#080808", padding: "20px 0" }}>
            <div style={{ padding: "0 20px 20px", borderBottom: "1px solid #141414" }}>
              <div style={{ color: "#3b82f6", fontSize: 10, letterSpacing: 2, marginBottom: 12, textTransform: "uppercase" }}>
                Active Queue
              </div>
              <div style={{ color: "#e0e0e0", fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{snapshot.queue.name}</div>
              <div style={{ color: "#444", fontSize: 9, marginBottom: 6 }}>pda: {truncate(snapshot.queue.publicKey, 12, 10)}</div>
              <div style={{ color: "#444", fontSize: 9 }}>authority: {truncate(snapshot.queue.authority, 12, 10)}</div>
            </div>

            <div style={{ padding: "16px 20px", borderBottom: "1px solid #141414" }}>
              <div style={{ color: "#333", fontSize: 9, letterSpacing: 2, marginBottom: 12 }}>FILTER BY STATUS</div>
              {STATUS_FILTERS.map((status) => {
                const count = statusCount(snapshot, status);
                const active = filter === status;
                const colors = status !== "all" ? STATUS_COLORS[status] : null;
                return (
                  <button
                    key={status}
                    onClick={() => setFilter(status)}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      width: "100%",
                      background: active ? "#161616" : "transparent",
                      border: "none",
                      borderLeft: active ? `2px solid ${colors?.accent ?? "#3b82f6"}` : "2px solid transparent",
                      color: active ? (colors?.text ?? "#93c5fd") : "#555",
                      cursor: "pointer",
                      padding: "7px 12px",
                      fontSize: 10,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      fontFamily: "'IBM Plex Mono', monospace",
                      textAlign: "left",
                    }}
                  >
                    <span>{status === "all" ? "ALL JOBS" : status}</span>
                    <span style={{ color: active ? (colors?.accent ?? "#3b82f6") : "#333", fontSize: 10 }}>{count}</span>
                  </button>
                );
              })}
            </div>

            <div style={{ padding: "16px 20px", borderBottom: "1px solid #141414" }}>
              <div style={{ color: "#333", fontSize: 9, letterSpacing: 2, marginBottom: 12 }}>WALLET WRITE PATH</div>
              <div style={{ color: wallet.connected ? "#86efac" : "#666", fontSize: 10, lineHeight: 1.8 }}>
                <div>{wallet.connected ? `connected: ${wallet.shortAddress}` : "connect a wallet to enqueue jobs"}</div>
                <div>{snapshot.queue.paused ? "queue is paused for new jobs" : "dashboard writes go straight to the program"}</div>
              </div>
            </div>

            <div style={{ padding: "16px 20px", borderBottom: "1px solid #141414" }}>
              <div style={{ color: "#333", fontSize: 9, letterSpacing: 2, marginBottom: 12 }}>OPERATIONS</div>
              <div style={{ color: "#666", fontSize: 10, lineHeight: 1.8 }}>
                <div>producer: dashboard form or `npm run client:devnet`</div>
                <div>worker: `npm run worker:devnet -- {snapshot.queue.publicKey}`</div>
                <div>last refresh: {formatTimestamp(snapshot.fetchedAt)}</div>
              </div>
            </div>

            <div style={{ padding: "16px 20px" }}>
              <div style={{ color: "#333", fontSize: 9, letterSpacing: 2, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ animation: "blink 1s step-end infinite", color: "#3b82f6" }}>o</span>
                LIVE EVENTS
              </div>
              {events.map((event) => (
                <div
                  key={event.id}
                  style={{
                    color: event.kind === "event" ? "#888" : "#555",
                    fontSize: 9,
                    lineHeight: 1.8,
                    animation: "fadeIn 0.3s ease",
                    marginBottom: 4,
                  }}
                >
                  <div>{event.text}</div>
                  <div style={{ color: "#333" }}>{formatTimestamp(event.timestamp)}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1, borderBottom: "1px solid #141414" }}>
              <StatCard label="Total Jobs" value={snapshot.queue.totalJobs} accent="#3b82f6" sublabel={`${snapshot.jobs.length} readable account(s)`} />
              <StatCard label="Pending" value={snapshot.queue.pendingJobs} accent="#f59e0b" sublabel="pending + processing tracked on-chain" />
              <StatCard label="Completed" value={snapshot.queue.completedJobs} accent="#22c55e" sublabel={`${successRate}% observed success rate`} />
              <StatCard label="Failed" value={snapshot.queue.failedJobs} accent="#ef4444" sublabel={snapshot.queue.paused ? "queue is paused" : "queue is accepting jobs"} />
            </div>

            <CreateJobForm
              cluster={cluster}
              queue={snapshot.queue}
              wallet={wallet}
              onJobCreated={handleJobCreated}
            />

            <div style={{ display: "grid", gridTemplateColumns: selectedJob ? "1fr 380px" : "1fr", flex: 1, overflow: "hidden" }}>
              <div style={{ overflow: "auto" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "60px 1fr 110px 80px 90px 70px 60px",
                    gap: 16,
                    padding: "8px 16px",
                    borderBottom: "1px solid #1a1a1a",
                    background: "#080808",
                  }}
                >
                  {["ID", "JOB TYPE", "STATUS", "PRIORITY", "RETRIES", "AGE", ""].map((heading, idx) => (
                    <span key={idx} style={{ color: "#333", fontSize: 9, letterSpacing: 2 }}>
                      {heading}
                    </span>
                  ))}
                </div>

                {filteredJobs.length === 0 ? (
                  <div style={{ color: "#333", fontSize: 11, textAlign: "center", padding: 60 }}>
                    NO JOBS MATCH THIS FILTER
                  </div>
                ) : (
                  filteredJobs.map((job) => (
                    <JobRow
                      key={job.publicKey}
                      job={job}
                      onClick={() => setSelectedJobKey((current) => (current === job.publicKey ? null : job.publicKey))}
                      selected={selectedJobKey === job.publicKey}
                      onCancel={handleCancelJob}
                      isCancelling={cancellingJobIds.has(job.publicKey)}
                    />
                  ))
                )}
              </div>

              {selectedJob ? (
                <div style={{ borderLeft: "1px solid #1a1a1a", overflow: "auto" }}>
                  <JobDetail job={selectedJob} onClose={() => setSelectedJobKey(null)} />
                </div>
              ) : null}
            </div>

            <div
              style={{
                borderTop: "1px solid #141414",
                padding: "8px 20px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#080808",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              <div style={{ color: "#333", fontSize: 9 }}>
                SLOT <span style={{ color: "#555" }}>#{snapshot.slot.toLocaleString()}</span>
                {"  |  "}
                QUEUE PDA <span style={{ color: "#555" }}>{truncate(snapshot.queue.publicKey, 16, 10)}</span>
              </div>
              <div style={{ display: "flex", gap: 16, color: "#333", fontSize: 9, flexWrap: "wrap" }}>
                <a
                  href={`https://explorer.solana.com/address/${snapshot.queue.publicKey}?cluster=${cluster}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#3b82f650", textDecoration: "none" }}
                >
                  VIEW QUEUE ON EXPLORER
                </a>
                <span>anchor v0.30.1</span>
                <span style={{ color: snapshot.queue.paused ? "#ef4444" : "#22c55e" }}>
                  {snapshot.queue.paused ? "PAUSED" : "RUNNING"}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
