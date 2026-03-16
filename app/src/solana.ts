import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import idlJson from "./idl/dec_queue.json";
import {
  MAX_JOB_PAYLOAD_BYTES,
  MAX_JOB_TYPE_LENGTH,
  PROGRAM_ID,
  deriveJobPda,
  enqueueJobWithProgram,
  cancelJobWithProgram,
  endpointForCluster,
  payloadByteLength,
} from "./decqueue-core";
import type { BrowserWalletAdapter } from "./useSolanaWallet";

export type Cluster = "devnet" | "localnet";
export type JobStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";

export interface QueueView {
  publicKey: string;
  name: string;
  authority: string;
  totalJobs: number;
  pendingJobs: number;
  completedJobs: number;
  failedJobs: number;
  maxRetries: number;
  paused: boolean;
  createdAt: Date;
}

export interface JobView {
  publicKey: string;
  jobId: number;
  jobType: string;
  payload: unknown;
  payloadText: string;
  status: JobStatus;
  priority: 0 | 1 | 2;
  createdAt: Date;
  executeAfter: Date;
  attempts: number;
  maxRetries: number;
  worker?: string;
  startedAt?: Date;
  completedAt?: Date;
  result?: string;
  errorMessage?: string;
}

export interface QueueSnapshot {
  queue: QueueView;
  jobs: JobView[];
  slot: number;
  fetchedAt: Date;
}

export interface LiveEvent {
  id: string;
  text: string;
  timestamp: Date;
  kind: "event" | "system";
}

const IDL = idlJson as Idl;
const decoder = new TextDecoder();
const IDL_PROGRAM_ID = new PublicKey((idlJson as { address: string }).address);

export interface EnqueueJobResult {
  jobId: number;
  jobPda: string;
  signature: string;
  payloadBytes: number;
}

const READONLY_WALLET = {
  publicKey: new PublicKey("11111111111111111111111111111111"),
  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    return transaction;
  },
  async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
    return transactions;
  },
};

function createAnchorWallet(wallet: BrowserWalletAdapter) {
  return {
    get publicKey(): PublicKey {
      if (!wallet.publicKey) {
        throw new Error("Connect your wallet to enqueue a job.");
      }

      return wallet.publicKey;
    },
    async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
      return wallet.signTransaction(transaction);
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
      if (wallet.signAllTransactions) {
        return wallet.signAllTransactions(transactions);
      }

      return Promise.all(transactions.map((transaction) => wallet.signTransaction(transaction)));
    },
  };
}

function getProgram(cluster: Cluster, wallet?: BrowserWalletAdapter | null) {
  const connection = new Connection(endpointForCluster(cluster), "confirmed");
  const provider = new AnchorProvider(connection, wallet ? createAnchorWallet(wallet) : READONLY_WALLET, {
    commitment: "confirmed",
  });
  const program = new Program(IDL, provider) as any;
  return { connection, program };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function toNumber(value: { toNumber(): number } | number): number {
  return typeof value === "number" ? value : value.toNumber();
}

function toDate(value: { toNumber(): number } | number | null | undefined): Date | undefined {
  if (value == null) {
    return undefined;
  }

  return new Date(toNumber(value) * 1000);
}

function parsePayload(payload: number[] | Uint8Array): { parsed: unknown; text: string } {
  const text = decoder.decode(payload instanceof Uint8Array ? payload : Uint8Array.from(payload));
  if (!text) {
    return { parsed: {}, text: "" };
  }

  try {
    return { parsed: JSON.parse(text), text };
  } catch {
    return { parsed: text, text };
  }
}

function normalizeJob(jobPublicKey: PublicKey, rawJob: any): JobView {
  const { parsed, text } = parsePayload(rawJob.payload);
  const status = (Object.keys(rawJob.status)[0] ?? "pending") as JobStatus;

  return {
    publicKey: jobPublicKey.toBase58(),
    jobId: toNumber(rawJob.jobId),
    jobType: rawJob.jobType,
    payload: parsed,
    payloadText: text,
    status,
    priority: rawJob.priority as 0 | 1 | 2,
    createdAt: toDate(rawJob.createdAt) ?? new Date(0),
    executeAfter: toDate(rawJob.executeAfter) ?? new Date(0),
    attempts: rawJob.attempts,
    maxRetries: rawJob.maxRetries,
    worker: rawJob.worker?.toBase58(),
    startedAt: toDate(rawJob.startedAt),
    completedAt: toDate(rawJob.completedAt),
    result: rawJob.result ?? undefined,
    errorMessage: rawJob.errorMessage ?? undefined,
  };
}

function formatEvent(eventName: string, event: any): string {
  switch (eventName) {
    case "jobEnqueued":
      return `JOB #${event.jobId.toNumber()} [${event.jobType}] ENQUEUED`;
    case "jobClaimed":
      return `JOB #${event.jobId.toNumber()} CLAIMED by ${event.worker.toBase58().slice(0, 4)}...${event.worker.toBase58().slice(-4)}`;
    case "jobCompleted":
      return `JOB #${event.jobId.toNumber()} COMPLETED`;
    case "jobFailed":
      return `JOB #${event.jobId.toNumber()} FAILED after ${event.attempts} attempts`;
    case "jobRetrying":
      return `JOB #${event.jobId.toNumber()} RETRYING -> attempt ${event.attempt}`;
    case "jobCancelled":
      return `JOB #${event.jobId.toNumber()} CANCELLED`;
    case "queuePauseChanged":
      return `QUEUE ${event.paused ? "PAUSED" : "RESUMED"}`;
    default:
      return eventName;
  }
}

export function getProgramId(): string {
  return IDL_PROGRAM_ID.toBase58();
}

export function getPayloadByteLength(payload: unknown): number {
  return payloadByteLength(payload);
}

export async function enqueueJobFromWallet({
  cluster,
  queueAddress,
  wallet,
  jobType,
  payload,
  priority = 1,
  delay = 0,
}: {
  cluster: Cluster;
  queueAddress: string;
  wallet: BrowserWalletAdapter | null;
  jobType: string;
  payload: unknown;
  priority?: 0 | 1 | 2;
  delay?: number;
}): Promise<EnqueueJobResult> {
  if (!wallet?.publicKey) {
    throw new Error("Connect your wallet to enqueue a job.");
  }

  const queuePublicKey = new PublicKey(queueAddress);
  const { program } = getProgram(cluster, wallet);
  const result = await enqueueJobWithProgram({
    program,
    payer: wallet.publicKey,
    queuePda: queuePublicKey,
    jobType,
    payload,
    options: { priority, delay },
  });

  return {
    jobId: result.jobId,
    jobPda: result.jobPda.toBase58(),
    signature: result.signature,
    payloadBytes: result.payloadBytes,
  };
}

export async function cancelJobFromWallet({
  cluster,
  queueAddress,
  wallet,
  jobAddress,
}: {
  cluster: Cluster;
  queueAddress: string;
  wallet: BrowserWalletAdapter | null;
  jobAddress: string;
}): Promise<string> {
  if (!wallet?.publicKey) {
    throw new Error("Connect your wallet to cancel a job.");
  }

  const queuePublicKey = new PublicKey(queueAddress);
  const jobPublicKey = new PublicKey(jobAddress);
  const { program } = getProgram(cluster, wallet);

  return cancelJobWithProgram({
    program,
    authority: wallet.publicKey,
    queuePda: queuePublicKey,
    jobPda: jobPublicKey,
    indexPageSeq: 0,
  });
}

export async function fetchQueueSnapshot(cluster: Cluster, queueAddress: string): Promise<QueueSnapshot> {
  const queuePublicKey = new PublicKey(queueAddress);
  const { connection, program } = getProgram(cluster);
  const [rawQueue, slot] = await Promise.all([
    program.account.queue.fetch(queuePublicKey),
    connection.getSlot("confirmed"),
  ]);

  const totalJobs = toNumber(rawQueue.jobCount);
  const jobKeys = Array.from(
    { length: totalJobs },
    (_, index) => deriveJobPda(PROGRAM_ID, queuePublicKey, index)[0]
  );
  const jobs: JobView[] = [];

  for (const keyChunk of chunk(jobKeys, 50)) {
    const batch = await program.account.job.fetchMultiple(keyChunk);
    batch.forEach((rawJob: any, index: number) => {
      if (rawJob) {
        jobs.push(normalizeJob(keyChunk[index], rawJob));
      }
    });
  }

  jobs.sort((left, right) => {
    if (left.status !== right.status) {
      const order: Record<JobStatus, number> = {
        processing: 0,
        pending: 1,
        failed: 2,
        completed: 3,
        cancelled: 4,
      };
      return order[left.status] - order[right.status];
    }

    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }

    return right.createdAt.getTime() - left.createdAt.getTime();
  });

  return {
    queue: {
      publicKey: queuePublicKey.toBase58(),
      name: rawQueue.name,
      authority: rawQueue.authority.toBase58(),
      totalJobs,
      pendingJobs: toNumber(rawQueue.pendingCount),
      completedJobs: toNumber(rawQueue.processedCount),
      failedJobs: toNumber(rawQueue.failedCount),
      maxRetries: rawQueue.maxRetries,
      paused: rawQueue.paused,
      createdAt: toDate(rawQueue.createdAt) ?? new Date(0),
    },
    jobs,
    slot,
    fetchedAt: new Date(),
  };
}

export async function subscribeToQueueEvents(
  cluster: Cluster,
  queueAddress: string,
  onEvent: (event: LiveEvent) => void
): Promise<() => Promise<void>> {
  const queuePublicKey = new PublicKey(queueAddress);
  const { program } = getProgram(cluster);
  const eventNames = [
    "jobEnqueued",
    "jobClaimed",
    "jobCompleted",
    "jobFailed",
    "jobRetrying",
    "jobCancelled",
    "queuePauseChanged",
  ];

  const listenerIds = await Promise.all(
    eventNames.map((eventName) =>
      program.addEventListener(eventName, (event: any) => {
        const eventQueue = event.queue?.toBase58?.();
        if (eventQueue && eventQueue !== queuePublicKey.toBase58()) {
          return;
        }

        onEvent({
          id: `${eventName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: formatEvent(eventName, event),
          timestamp: new Date(),
          kind: "event",
        });
      })
    )
  );

  return async () => {
    await Promise.all(listenerIds.map((listenerId) => program.removeEventListener(listenerId)));
  };
}

export { MAX_JOB_PAYLOAD_BYTES, MAX_JOB_TYPE_LENGTH };
