import { BN } from "@coral-xyz/anchor";
import { Buffer } from "buffer";
import { PublicKey, SystemProgram } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("GQdb3Gabjd28jXVnNZguU9cTwYsxw7Emrn2voQoyJA4a");
export const MAX_JOB_PAYLOAD_BYTES = 512;
export const MAX_JOB_TYPE_LENGTH = 32;

export type Cluster = "devnet" | "localnet";
export type JobPriority = 0 | 1 | 2;

export interface EnqueueJobOptions {
  priority?: JobPriority;
  delay?: number;
}

export interface EnqueueJobResult {
  jobPda: PublicKey;
  jobId: number;
  signature: string;
  payloadBytes: number;
}

export function endpointForCluster(cluster: Cluster): string {
  return cluster === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899";
}

export function toNumber(value: { toNumber(): number } | number): number {
  return typeof value === "number" ? value : value.toNumber();
}

export function deriveJobPda(
  programId: PublicKey,
  queuePubkey: PublicKey,
  jobId: number
): [PublicKey, number] {
  const idBytes = new Uint8Array(8);
  const view = new DataView(idBytes.buffer);
  view.setBigUint64(0, BigInt(jobId), true);

  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("job"), queuePubkey.toBytes(), idBytes],
    programId
  );
}

export function deriveIndexPagePda(
  programId: PublicKey,
  queuePubkey: PublicKey,
  seq: number
): [PublicKey, number] {
  const seqBytes = new Uint8Array(8);
  const view = new DataView(seqBytes.buffer);
  view.setBigUint64(0, BigInt(seq), true);

  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("index"), queuePubkey.toBytes(), seqBytes],
    programId
  );
}

export function serializeJobPayload(payload: unknown): Uint8Array {
  const encoded = JSON.stringify(payload);

  if (encoded == null) {
    throw new Error("Payload must be valid JSON.");
  }

  return Buffer.from(encoded, "utf8");
}

export function payloadByteLength(payload: unknown): number {
  return serializeJobPayload(payload).byteLength;
}

export function buildExecuteAfter(delay = 0): BN {
  if (!Number.isFinite(delay) || delay < 0) {
    throw new Error("Delay must be zero or greater.");
  }

  if (delay === 0) {
    return new BN(0);
  }

  return new BN(Math.floor(Date.now() / 1000) + Math.floor(delay / 1000));
}

export async function enqueueJobWithProgram({
  program,
  payer,
  queuePda,
  jobType,
  payload,
  options = {},
}: {
  program: any;
  payer: PublicKey;
  queuePda: PublicKey;
  jobType: string;
  payload: unknown;
  options?: EnqueueJobOptions;
}): Promise<EnqueueJobResult> {
  const normalizedJobType = jobType.trim();
  const { priority = 1, delay = 0 } = options;

  if (!normalizedJobType) {
    throw new Error("Job type is required.");
  }

  if (normalizedJobType.length > MAX_JOB_TYPE_LENGTH) {
    throw new Error(`Job type must be ${MAX_JOB_TYPE_LENGTH} characters or fewer.`);
  }

  if (!Number.isInteger(priority) || priority < 0 || priority > 2) {
    throw new Error("Priority must be 0 (low), 1 (normal), or 2 (high).");
  }

  const payloadBytes = serializeJobPayload(payload);
  if (payloadBytes.byteLength > MAX_JOB_PAYLOAD_BYTES) {
    throw new Error(
      `Payload is ${payloadBytes.byteLength} bytes. The on-chain limit is ${MAX_JOB_PAYLOAD_BYTES} bytes.`
    );
  }

  const queueData = await program.account.queue.fetch(queuePda);
  const jobId = toNumber(queueData.jobCount);
  const [jobPda] = deriveJobPda(program.programId, queuePda, jobId);
  const executeAfter = buildExecuteAfter(delay);

  const signature = await program.methods
    .enqueueJob(payloadBytes, normalizedJobType, priority, executeAfter)
    .accounts({
      queue: queuePda,
      job: jobPda,
      payer,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  return { jobPda, jobId, signature, payloadBytes: payloadBytes.byteLength };
}

export async function cancelJobWithProgram({
  program,
  authority,
  queuePda,
  jobPda,
  indexPageSeq = 0,
}: {
  program: any;
  authority: PublicKey;
  queuePda: PublicKey;
  jobPda: PublicKey;
  indexPageSeq?: number;
}): Promise<string> {
  const [sourceIndexPage] = deriveIndexPagePda(program.programId, queuePda, indexPageSeq);

  return program.methods
    .cancelJob()
    .accounts({
      queue: queuePda,
      job: jobPda,
      authority,
      sourceIndexPage,
    } as any)
    .rpc();
}
