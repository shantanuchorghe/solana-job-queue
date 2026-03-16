import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SolQueue } from "../target/types/sol_queue";
import idl from "../target/idl/sol_queue.json";

export const PROGRAM_ID = new PublicKey("BuG2BPUX7iFZ34Q7yEiFdAdFifXmkr4of1AvLtmnBpas");

export type Cluster = "devnet" | "localnet" | "mainnet-beta";

export interface JobData {
  [key: string]: unknown;
}

export interface JobRecord {
  publicKey: PublicKey;
  jobId: number;
  jobType: string;
  payload: JobData;
  status: string;
  priority: number;
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

export interface QueueStats {
  name: string;
  authority: string;
  totalJobs: number;
  pendingJobs: number;
  completedJobs: number;
  failedJobs: number;
  paused: boolean;
  createdAt: Date;
}

export function endpointForCluster(cluster: Cluster): string {
  const endpoints: Record<Cluster, string> = {
    devnet: "https://api.devnet.solana.com",
    localnet: "http://127.0.0.1:8899",
    "mainnet-beta": "https://api.mainnet-beta.solana.com",
  };

  return endpoints[cluster];
}

export function formatTxLocation(signature: string, cluster: Cluster): string {
  if (cluster === "localnet") {
    return signature;
  }

  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}

export function formatAddressLocation(address: string, cluster: Cluster): string {
  if (cluster === "localnet") {
    return address;
  }

  return `https://explorer.solana.com/address/${address}?cluster=${cluster}`;
}

export function defaultWalletPath(): string {
  return path.join(os.homedir(), ".config", "solana", "id.json");
}

export function loadKeypairFromFile(walletPath: string): Keypair {
  const keypairData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

export function loadWalletFromFile(walletPath = defaultWalletPath()): anchor.Wallet {
  return new anchor.Wallet(loadKeypairFromFile(walletPath));
}

export class SolQueueClient {
  constructor(
    public program: Program<SolQueue>,
    public provider: AnchorProvider
  ) {}

  static async connect(
    wallet: anchor.Wallet,
    cluster: Cluster = "localnet"
  ): Promise<SolQueueClient> {
    const connection = new Connection(endpointForCluster(cluster), "confirmed");
    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

    const program = new Program<SolQueue>(idl as unknown as SolQueue, provider);
    return new SolQueueClient(program, provider);
  }

  deriveQueuePda(authority: PublicKey, queueName: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("queue"), authority.toBuffer(), Buffer.from(queueName)],
      this.program.programId
    );
  }

  deriveJobPda(queuePubkey: PublicKey, jobId: number): [PublicKey, number] {
    const idBuffer = Buffer.alloc(8);
    idBuffer.writeBigUInt64LE(BigInt(jobId));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("job"), queuePubkey.toBuffer(), idBuffer],
      this.program.programId
    );
  }

  async createQueue(
    name: string,
    options: { maxRetries?: number } = {}
  ): Promise<{ queuePda: PublicKey; signature: string }> {
    const { maxRetries = 3 } = options;
    const authority = this.provider.wallet.publicKey;
    const [queuePda] = this.deriveQueuePda(authority, name);

    const signature = await this.program.methods
      .initializeQueue(name, maxRetries)
      .accounts({
        queue: queuePda,
        authority,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    return { queuePda, signature };
  }

  async getQueueStats(queuePda: PublicKey): Promise<QueueStats> {
    const data = await this.program.account.queue.fetch(queuePda);
    return {
      name: data.name,
      authority: data.authority.toBase58(),
      totalJobs: data.jobCount.toNumber(),
      pendingJobs: data.pendingCount.toNumber(),
      completedJobs: data.processedCount.toNumber(),
      failedJobs: data.failedCount.toNumber(),
      paused: data.paused,
      createdAt: new Date(data.createdAt.toNumber() * 1000),
    };
  }

  async addJob(
    queuePda: PublicKey,
    jobType: string,
    data: JobData,
    options: {
      priority?: 0 | 1 | 2;
      delay?: number;
    } = {}
  ): Promise<{ jobPda: PublicKey; jobId: number; signature: string }> {
    const { priority = 1, delay = 0 } = options;
    const queueData = await this.program.account.queue.fetch(queuePda);
    const jobId = queueData.jobCount.toNumber();
    const [jobPda] = this.deriveJobPda(queuePda, jobId);
    const payload = Buffer.from(JSON.stringify(data));
    const executeAfter =
      delay > 0
        ? new BN(Math.floor(Date.now() / 1000) + Math.floor(delay / 1000))
        : new BN(0);

    const signature = await this.program.methods
      .enqueueJob(payload, jobType, priority, executeAfter)
      .accounts({
        queue: queuePda,
        job: jobPda,
        payer: this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    return { jobPda, jobId, signature };
  }

  async getJob(jobPda: PublicKey): Promise<JobRecord> {
    const data = await this.program.account.job.fetch(jobPda);
    const statusKey = Object.keys(data.status)[0];

    return {
      publicKey: jobPda,
      jobId: data.jobId.toNumber(),
      jobType: data.jobType,
      payload: JSON.parse(Buffer.from(data.payload).toString()),
      status: statusKey,
      priority: data.priority,
      createdAt: new Date(data.createdAt.toNumber() * 1000),
      executeAfter: new Date(data.executeAfter.toNumber() * 1000),
      attempts: data.attempts,
      maxRetries: data.maxRetries,
      worker: data.worker?.toBase58(),
      startedAt: data.startedAt ? new Date(data.startedAt.toNumber() * 1000) : undefined,
      completedAt: data.completedAt ? new Date(data.completedAt.toNumber() * 1000) : undefined,
      result: data.result ?? undefined,
      errorMessage: data.errorMessage ?? undefined,
    };
  }

  async getAllJobs(queuePda: PublicKey): Promise<JobRecord[]> {
    const queueData = await this.program.account.queue.fetch(queuePda);
    const totalJobs = queueData.jobCount.toNumber();
    const jobs: JobRecord[] = [];

    for (let id = 0; id < totalJobs; id += 1) {
      const [jobPda] = this.deriveJobPda(queuePda, id);
      try {
        jobs.push(await this.getJob(jobPda));
      } catch {
        // Skip missing accounts.
      }
    }

    return jobs;
  }

  async claimJob(jobPda: PublicKey, workerKeypair: Keypair): Promise<string> {
    return this.program.methods
      .claimJob()
      .accounts({ job: jobPda, worker: workerKeypair.publicKey })
      .signers([workerKeypair])
      .rpc();
  }

  async completeJob(
    queuePda: PublicKey,
    jobPda: PublicKey,
    workerKeypair: Keypair,
    result?: string
  ): Promise<string> {
    return this.program.methods
      .completeJob(result ?? null)
      .accounts({ queue: queuePda, job: jobPda, worker: workerKeypair.publicKey } as any)
      .signers([workerKeypair])
      .rpc();
  }

  async failJob(
    queuePda: PublicKey,
    jobPda: PublicKey,
    workerKeypair: Keypair,
    errorMessage: string,
    retryAfterSecs = 30
  ): Promise<string> {
    return this.program.methods
      .failJob(errorMessage, new BN(retryAfterSecs))
      .accounts({ queue: queuePda, job: jobPda, worker: workerKeypair.publicKey } as any)
      .signers([workerKeypair])
      .rpc();
  }

  async setQueuePaused(queuePda: PublicKey, paused: boolean): Promise<string> {
    return this.program.methods
      .setQueuePaused(paused)
      .accounts({ queue: queuePda, authority: this.provider.wallet.publicKey })
      .rpc();
  }

  onJobCompleted(callback: (event: { jobId: number; result?: string }) => void) {
    return this.program.addEventListener("jobCompleted", (event) => {
      callback({ jobId: event.jobId.toNumber(), result: event.result ?? undefined });
    });
  }

  onJobFailed(callback: (event: { jobId: number; error: string; attempts: number }) => void) {
    return this.program.addEventListener("jobFailed", (event) => {
      callback({ jobId: event.jobId.toNumber(), error: event.error, attempts: event.attempts });
    });
  }

  removeListener(listenerId: number) {
    return this.program.removeEventListener(listenerId);
  }
}

async function main() {
  const walletPath = process.env.WALLET_PATH ?? defaultWalletPath();
  const cluster = (process.env.SOLQUEUE_CLUSTER as Cluster | undefined) ?? "localnet";
  const queueName = process.env.SOLQUEUE_QUEUE_NAME ?? `email-${Date.now().toString(36)}`;
  const payer = loadKeypairFromFile(walletPath);
  const wallet = new anchor.Wallet(payer);

  console.log(`Connecting to ${cluster}...`);
  const client = await SolQueueClient.connect(wallet, cluster);
  console.log(`   Wallet: ${payer.publicKey.toBase58()}\n`);

  console.log(`Creating queue: ${queueName}`);
  const { queuePda, signature: createSig } = await client.createQueue(queueName, {
    maxRetries: 3,
  });
  console.log(`   Queue PDA: ${queuePda.toBase58()}`);
  console.log(`   Tx: ${formatTxLocation(createSig, cluster)}\n`);

  console.log("Enqueuing jobs...");
  const jobs: Array<{
    type: string;
    data: JobData;
    priority: 0 | 1 | 2;
    delay?: number;
  }> = [
    { type: "send-email", data: { to: "alice@example.com", subject: "Welcome" }, priority: 2 },
    { type: "send-email", data: { to: "bob@example.com", subject: "Invoice" }, priority: 1 },
    {
      type: "webhook-call",
      data: { url: "https://api.example.com/hook", event: "signup" },
      priority: 1,
    },
    { type: "daily-report", data: { reportId: "Q1-2025" }, priority: 0, delay: 60000 },
  ];

  for (const jobDef of jobs) {
    const { jobPda, jobId, signature } = await client.addJob(queuePda, jobDef.type, jobDef.data, {
      priority: jobDef.priority,
      delay: jobDef.delay,
    });
    console.log(`   Job #${jobId} (${jobDef.type}) -> ${jobPda.toBase58().slice(0, 20)}...`);
    console.log(`   Tx: ${formatTxLocation(signature, cluster)}`);
  }

  console.log("\nQueue Stats:");
  const stats = await client.getQueueStats(queuePda);
  console.log(`   Pending:   ${stats.pendingJobs}`);
  console.log(`   Total:     ${stats.totalJobs}`);
  console.log(`   Completed: ${stats.completedJobs}`);
  console.log(`   Failed:    ${stats.failedJobs}`);
  console.log(`   Paused:    ${stats.paused}`);

  console.log("\nAll Jobs:");
  const allJobs = await client.getAllJobs(queuePda);
  for (const job of allJobs) {
    const since = Math.round((Date.now() - job.createdAt.getTime()) / 1000);
    console.log(`   #${job.jobId} [${job.status.padEnd(10)}] ${job.jobType.padEnd(15)} ${since}s ago`);
  }

  if (cluster === "localnet") {
    console.log("\nDone. Queue address:");
  } else {
    console.log("\nDone. Queue location:");
  }
  console.log(`   ${formatAddressLocation(queuePda.toBase58(), cluster)}`);
}

if (require.main === module) {
  main().catch(console.error);
}
