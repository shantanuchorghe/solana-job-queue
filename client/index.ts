import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// @lightprotocol/stateless.js — TypeScript client for the Light System Program.
// This is a pure npm package; it has no Rust/Cargo dependency conflicts.
// It wraps the Light indexer RPC to:
//   1. Fetch compressed account data (stored in ledger, not getAccountInfo)
//   2. Fetch ValidityProofs needed to mutate compressed accounts on-chain
import {
  createRpc,
  type Rpc,
  type CompressedAccountMeta as LightCompressedAccountMeta,
} from "@lightprotocol/stateless.js";

import {
  PROGRAM_ID,
  deriveJobPda,
  deriveIndexPda,
  deriveQueuePda,
  enqueueJobWithProgram,
  endpointForCluster,
  type Cluster,
  type IndexType,
} from "../shared/solqueue-core";
import { SolQueue } from "../target/types/sol_queue";
import idl from "../target/idl/sol_queue.json";

export type { Cluster };

// Light Protocol indexer RPC endpoints per cluster.
// Workers fetch ValidityProofs from these before sending compressed-account
// transactions. Different from the standard Solana RPC — the Light indexer
// tracks the Merkle trees and can generate ZK proofs.
const LIGHT_RPC_ENDPOINT: Record<string, string> = {
  devnet:       "https://zk-testnet.helius.dev:8899",
  "mainnet-beta": "https://mainnet.helius-rpc.com",
  localnet:     "http://localhost:8899", // local validator with light-system-program
};

function lightRpcForCluster(cluster: Cluster): string {
  return LIGHT_RPC_ENDPOINT[cluster] ?? LIGHT_RPC_ENDPOINT.devnet;
}


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
    return deriveQueuePda(this.program.programId, authority, queueName);
  }

  deriveJobPda(queuePubkey: PublicKey, jobId: number): [PublicKey, number] {
    return deriveJobPda(this.program.programId, queuePubkey, jobId);
  }

  deriveIndexPda(queuePubkey: PublicKey, indexType: IndexType): [PublicKey, number] {
    return deriveIndexPda(this.program.programId, queuePubkey, indexType);
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

  async initializeIndexes(queuePda: PublicKey): Promise<string> {
    const authority = this.provider.wallet.publicKey;
    const [pendingIndex] = this.deriveIndexPda(queuePda, "pending");
    const [processingIndex] = this.deriveIndexPda(queuePda, "processing");
    const [delayedIndex] = this.deriveIndexPda(queuePda, "delayed");
    const [failedIndex] = this.deriveIndexPda(queuePda, "failed");
    const [completedIndex] = this.deriveIndexPda(queuePda, "completed");
    const [cancelledIndex] = this.deriveIndexPda(queuePda, "cancelled");

    return this.program.methods
      .initializeIndexes()
      .accounts({
        queue: queuePda,
        pendingIndex,
        processingIndex,
        delayedIndex,
        failedIndex,
        completedIndex,
        cancelledIndex,
        authority,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  async getIndexJobIds(queuePda: PublicKey, indexType: IndexType): Promise<number[]> {
    const [indexPda] = this.deriveIndexPda(queuePda, indexType);
    try {
      const data = await this.program.account.jobIndex.fetch(indexPda);
      return data.jobIds.map((id: any) => (typeof id === "number" ? id : id.toNumber()));
    } catch {
      return [];
    }
  }

  async getReadyJobIds(queuePda: PublicKey): Promise<number[]> {
    const [pendingIds, delayedIds] = await Promise.all([
      this.getIndexJobIds(queuePda, "pending"),
      this.getIndexJobIds(queuePda, "delayed"),
    ]);
    return [...pendingIds, ...delayedIds];
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
    const result = await enqueueJobWithProgram({
      program: this.program,
      payer: this.provider.wallet.publicKey,
      queuePda,
      jobType,
      payload: data,
      options,
    });

    return {
      jobPda: result.jobPda,
      jobId: result.jobId,
      signature: result.signature,
    };
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

  // ── claimJob ─────────────────────────────────────────────────────────────
  // Standard path: mutates the on-chain Job PDA directly.
  // Compressed path: fetches a ValidityProof from the Light indexer and sends
  //   a claimCompressedJob instruction that atomically:
  //     1. Verifies proof (proves job is in PENDING state in Merkle tree)
  //     2. Removes job_id from source_index_page
  //     3. Updates compressed job hash to PROCESSING state
  async claimJob(
    jobPda: PublicKey,
    queuePda: PublicKey,
    workerKeypair: Keypair,
    options: { useCompressed?: boolean; cluster?: Cluster; indexPageSeq?: number } = {}
  ): Promise<string> {
    const { useCompressed = false, cluster = "devnet", indexPageSeq = 0 } = options;

    if (useCompressed) {
      return this._claimCompressed(jobPda, queuePda, workerKeypair, cluster, indexPageSeq);
    }

    // Standard path — derives source_index_page from the current head page seq.
    // For simplicity the page is passed as the first index page (seq=0) unless
    // the caller provides a specific seq via indexPageSeq.
    const [sourceIndexPage] = this._deriveIndexPagePda(queuePda, indexPageSeq);

    return this.program.methods
      .claimJob()
      .accounts({
        job:             jobPda,
        worker:          workerKeypair.publicKey,
        sourceIndexPage,
      } as any)
      .signers([workerKeypair])
      .rpc();
  }

  private async _claimCompressed(
    jobPda: PublicKey,
    queuePda: PublicKey,
    workerKeypair: Keypair,
    cluster: Cluster,
    indexPageSeq: number
  ): Promise<string> {
    const lightRpc     = createRpc(lightRpcForCluster(cluster));
    const { proof, meta, jobDataBytes } = await this._fetchProofAndMeta(lightRpc, jobPda);
    const [sourceIndexPage] = this._deriveIndexPagePda(queuePda, indexPageSeq);

    return this.program.methods
      .claimCompressedJob(proof, meta, Array.from(jobDataBytes))
      .accounts({
        worker:          workerKeypair.publicKey,
        payer:           workerKeypair.publicKey,
        sourceIndexPage,
      } as any)
      .remainingAccounts(await this._buildLightRemainingAccounts(lightRpc, meta))
      .signers([workerKeypair])
      .rpc();
  }

  // ── completeJob ────────────────────────────────────────────────────────────
  async completeJob(
    queuePda: PublicKey,
    jobPda: PublicKey,
    workerKeypair: Keypair,
    result?: string,
    options: { useCompressed?: boolean; cluster?: Cluster } = {}
  ): Promise<string> {
    const { useCompressed = false, cluster = "devnet" } = options;

    if (useCompressed) {
      return this._completeCompressed(queuePda, jobPda, workerKeypair, result, cluster);
    }

    return this.program.methods
      .completeJob(result ?? null)
      .accounts({
        queue:  queuePda,
        job:    jobPda,
        worker: workerKeypair.publicKey,
      } as any)
      .signers([workerKeypair])
      .rpc();
  }

  private async _completeCompressed(
    queuePda: PublicKey,
    jobPda: PublicKey,
    workerKeypair: Keypair,
    result: string | undefined,
    cluster: Cluster
  ): Promise<string> {
    const lightRpc = createRpc(lightRpcForCluster(cluster));
    const { proof, meta, jobDataBytes } = await this._fetchProofAndMeta(lightRpc, jobPda);

    return this.program.methods
      .completeCompressedJob(proof, meta, Array.from(jobDataBytes), result ?? null)
      .accounts({
        queue:  queuePda,
        worker: workerKeypair.publicKey,
        payer:  workerKeypair.publicKey,
      } as any)
      .remainingAccounts(await this._buildLightRemainingAccounts(lightRpc, meta))
      .signers([workerKeypair])
      .rpc();
  }

  // ── failJob ────────────────────────────────────────────────────────────────
  async failJob(
    queuePda: PublicKey,
    jobPda: PublicKey,
    workerKeypair: Keypair,
    errorMessage: string,
    retryAfterSecs = 30,
    options: { useCompressed?: boolean; cluster?: Cluster; retryIndexPageSeq?: number } = {}
  ): Promise<string> {
    const { useCompressed = false, cluster = "devnet", retryIndexPageSeq = 0 } = options;

    if (useCompressed) {
      return this._failCompressed(
        queuePda, jobPda, workerKeypair, errorMessage, retryAfterSecs, cluster, retryIndexPageSeq
      );
    }

    const [retryIndexPage] = this._deriveIndexPagePda(queuePda, retryIndexPageSeq);

    return this.program.methods
      .failJob(errorMessage, new BN(retryAfterSecs))
      .accounts({
        queue:          queuePda,
        job:            jobPda,
        worker:         workerKeypair.publicKey,
        retryIndexPage,
      } as any)
      .signers([workerKeypair])
      .rpc();
  }

  private async _failCompressed(
    queuePda: PublicKey,
    jobPda: PublicKey,
    workerKeypair: Keypair,
    errorMessage: string,
    retryAfterSecs: number,
    cluster: Cluster,
    retryIndexPageSeq: number
  ): Promise<string> {
    const lightRpc = createRpc(lightRpcForCluster(cluster));
    const { proof, meta, jobDataBytes } = await this._fetchProofAndMeta(lightRpc, jobPda);
    const [retryIndexPage] = this._deriveIndexPagePda(queuePda, retryIndexPageSeq);

    return this.program.methods
      .failCompressedJob(proof, meta, Array.from(jobDataBytes), errorMessage, new BN(retryAfterSecs))
      .accounts({
        queue:          queuePda,
        worker:         workerKeypair.publicKey,
        payer:          workerKeypair.publicKey,
        retryIndexPage,
      } as any)
      .remainingAccounts(await this._buildLightRemainingAccounts(lightRpc, meta))
      .signers([workerKeypair])
      .rpc();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Light Protocol helpers
  // ─────────────────────────────────────────────────────────────────────────

  // Derive a JobIndex page PDA by sequence number.
  // Seeds: ["index", queuePubkey, seq.to_le_bytes()]
  _deriveIndexPagePda(queuePda: PublicKey, seq: number): [PublicKey, number] {
    const seqBuf = Buffer.alloc(8);
    seqBuf.writeBigUInt64LE(BigInt(seq));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("index"), queuePda.toBuffer(), seqBuf],
      this.program.programId
    );
  }

  // Fetch a compressed job's current data + validity proof from the Light indexer.
  //
  // What the Light indexer returns:
  //   - compressedAccount.data.data  → borsh-serialized JobAccount bytes
  //     (this is what the on-chain handler borsh-deserializes from job_data)
  //   - compressedAccount.address    → the compressed account's unique address
  //   - proof                        → ValidityProof struct (ZK-SNARK)
  //   - CompressedAccountMeta        → hash + tree indices for LightAccount::new_mut()
  //
  // The proof is only valid for the CURRENT Merkle root.  If another transaction
  // updates the same leaf before this tx lands, the root changes and the proof
  // becomes invalid → tx reverts.  This is how double-claim is prevented.
  private async _fetchProofAndMeta(
    lightRpc: Rpc,
    jobPda: PublicKey // used as the compressed account address (deterministic seed)
  ): Promise<{
    proof: any;
    meta: any;
    jobDataBytes: Uint8Array;
  }> {
    // getCompressedAccount fetches the current state from the Light indexer.
    // Unlike getAccountInfo, this reads from the Merkle tree not from account data.
    const compressedAccount = await lightRpc.getCompressedAccount(
      undefined,
      jobPda // address — same deterministic key used during enqueue
    );

    if (!compressedAccount) {
      throw new Error(
        `Compressed job account not found for address ${jobPda.toBase58()}. ` +
        `Ensure the job was created with enqueue_compressed_job, ` +
        `not the standard enqueue_job.`
      );
    }

    const jobDataBytes = compressedAccount.data?.data
      ? Buffer.from(compressedAccount.data.data)
      : Buffer.alloc(0);

    // getValidityProof fetches a fresh ZK-SNARK proof from the indexer.
    // This proves: "this hash exists in the current Merkle root".
    // The proof is tied to the current root — it expires if the root changes.
    const proofResult = await lightRpc.getValidityProof(
      [{ hash: compressedAccount.hash, tree: compressedAccount.tree }],
      [] // no new addresses needed for updates
    );

    // Build CompressedAccountMeta from the fetched data.
    // This tells LightAccount::new_mut() which leaf to nullify.
    const meta = {
      hash:              compressedAccount.hash,
      address:           compressedAccount.address,
      treeInfo:          proofResult.treeInfo,
      outputStateMerkleTreeIndex: proofResult.treeInfo?.treeIndex ?? 0,
    };

    return { proof: proofResult.proof, meta, jobDataBytes };
  }

  // Build the remaining_accounts list required by the Light System Program.
  // These accounts are the State Merkle Tree + Nullifier Queue on-chain PDAs.
  // Their indices are packed into the instruction data by PackedAccounts.
  private async _buildLightRemainingAccounts(
    lightRpc: Rpc,
    meta: any
  ): Promise<Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>> {
    // The stateless.js SDK exposes `getStateTreeAccounts` or equivalent.
    // For now we return the canonical devnet state tree and nullifier queue.
    // In production, derive these from the treeInfo in the proof metadata.
    const LIGHT_STATE_TREE_DEVNET = new PublicKey(
      "smt1NamzXdq4AMqS2fS2F1i5KTYPZRhoHgWx38d8WsT"
    );
    const LIGHT_NULLIFIER_QUEUE_DEVNET = new PublicKey(
      "nfq1NvQDJ2GEgnS8zt9prAe8rjjpAW1zFkrvZoBR148"
    );
    const LIGHT_SYSTEM_PROGRAM = new PublicKey(
      "H5sFv8VwWmjxHYS2GB4fTDsK7uTtnRT4WiixtHrET3bN"
    );

    return [
      { pubkey: LIGHT_SYSTEM_PROGRAM,         isSigner: false, isWritable: false },
      { pubkey: LIGHT_STATE_TREE_DEVNET,       isSigner: false, isWritable: true  },
      { pubkey: LIGHT_NULLIFIER_QUEUE_DEVNET,  isSigner: false, isWritable: true  },
    ];
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
  console.log(`   Tx: ${formatTxLocation(createSig, cluster)}`);

  console.log(`Initializing indexes...`);
  const indexSig = await client.initializeIndexes(queuePda);
  console.log(`   Tx: ${formatTxLocation(indexSig, cluster)}\n`);

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
