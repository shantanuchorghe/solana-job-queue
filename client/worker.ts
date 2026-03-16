/**
 * worker.ts — DecQueue worker process with HybridFeeStrategy
 *
 * Environment variables:
 *
 *   DECQUEUE_CLUSTER        localnet | devnet | mainnet-beta (default: localnet)
 *   DECQUEUE_QUEUE          Queue PDA (alternative to positional arg)
 *   DECQUEUE_POLL_MS        Polling interval in ms (default: 5000)
 *   DECQUEUE_WORKER_ONCE    Set to "1" for a single processing pass then exit
 *   DECQUEUE_RETRY_AFTER_SECS  Base retry delay for failed jobs (default: 30)
 *   DECQUEUE_COMPRESSED     Set to "1" to use ZK-compressed job path
 *   WALLET_PATH             Path to the worker keypair JSON (default: ~/.config/solana/id.json)
 *
 *   ── Fee strategy ──────────────────────────────────────────────────────────
 *   DECQUEUE_FEE_MODE       standard | jito | auto  (default: auto)
 *   JITO_BLOCK_ENGINE_URL   Jito block engine REST URL
 *                           (default: https://ny.mainnet.block-engine.jito.wtf)
 *   JITO_TIP_LAMPORTS       Lamports to tip Jito per bundle (default: 25000)
 *   DECQUEUE_PRIORITY_FEE_PERCENTILE  0–100, fee percentile to bid (default: 75)
 *   DECQUEUE_MAX_SEND_ATTEMPTS        Max tx attempts before giving up (default: 4)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  Cluster,
  JobRecord,
  DecQueueClient,
  defaultWalletPath,
  formatAddressLocation,
  formatTxLocation,
  loadKeypairFromFile,
  loadWalletFromFile,
} from "./index";
import {
  HybridFeeStrategy,
  HybridFeeStrategyConfig,
  FeeMode,
  JobPriority,
  defaultHybridFeeConfig,
  getDynamicPriorityFee,
} from "./fee-strategy";

// ─────────────────────────────────────────────────────────────────────────────
// Config helpers
// ─────────────────────────────────────────────────────────────────────────────

const VALID_CLUSTERS = new Set<Cluster>(["localnet", "devnet", "mainnet-beta"]);

function parseCluster(value: string | undefined): Cluster | null {
  if (!value) return null;
  return VALID_CLUSTERS.has(value as Cluster) ? (value as Cluster) : null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  let cluster = parseCluster(process.env.DECQUEUE_CLUSTER) ?? "localnet";

  for (const arg of args) {
    const parsedCluster = parseCluster(arg);
    if (parsedCluster) { cluster = parsedCluster; continue; }
    positional.push(arg);
  }

  return { cluster, queueArg: positional[0] ?? process.env.DECQUEUE_QUEUE };
}

/** Build HybridFeeStrategyConfig from environment variables */
function buildFeeConfig(): HybridFeeStrategyConfig {
  const modeEnv = process.env.DECQUEUE_FEE_MODE as FeeMode | undefined;
  const validModes: FeeMode[] = ["standard", "jito", "auto"];
  const mode: FeeMode = validModes.includes(modeEnv!) ? modeEnv! : "auto";

  return defaultHybridFeeConfig({
    mode,
    priorityFeePercentile: Number(process.env.DECQUEUE_PRIORITY_FEE_PERCENTILE ?? 75),
    retry: {
      maxAttempts:       Number(process.env.DECQUEUE_MAX_SEND_ATTEMPTS ?? 4),
      baseDelayMs:       800,
      jitterFactor:      0.2,
      backoffMultiplier: 2.0,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Job utilities
// ─────────────────────────────────────────────────────────────────────────────

function jobSummary(job: JobRecord): string {
  const priorityLabel = ["low", "normal", "high"][job.priority] ?? job.priority;
  return `#${job.jobId} ${job.jobType} [${job.status}] (${priorityLabel})`;
}

function compactJson(value: unknown): string {
  return JSON.stringify(value).slice(0, 120);
}

function renderResult(job: JobRecord): string {
  const payload = job.payload as Record<string, unknown>;
  switch (job.jobType) {
    case "send-email":
      return compactJson({ ok: true, to: payload.to ?? "unknown", ref: `msg_${job.jobId.toString(36)}` });
    case "webhook-call":
      return compactJson({ ok: true, target: payload.url ?? "unknown", code: 202 });
    case "image-resize":
      return compactJson({ ok: true, asset: payload.imageId ?? `img_${job.jobId}`, variant: "thumbnail" });
    case "daily-report":
      return compactJson({ ok: true, report: payload.reportId ?? `report_${job.jobId}` });
    case "audit-log":
      return compactJson({ ok: true, entry: `audit_${job.jobId}` });
    default:
      return compactJson({ ok: true, handledBy: "decqueue-worker", type: job.jobType });
  }
}

async function executeJob(job: JobRecord): Promise<string> {
  const payload = job.payload as Record<string, unknown>;
  if (payload.fail === true || payload.shouldFail === true || payload.simulateFailure === true) {
    throw new Error("Job payload requested a simulated failure");
  }
  if (typeof payload.throwMessage === "string" && payload.throwMessage.trim().length > 0) {
    throw new Error(payload.throwMessage.trim());
  }
  return renderResult(job);
}

function sortReadyJobs(jobs: JobRecord[]): JobRecord[] {
  return jobs
    .filter((job) => job.status === "pending" && job.executeAfter.getTime() <= Date.now())
    .sort((a, b) => {
      // Primary: priority desc (high=2 first)
      if (a.priority !== b.priority) return b.priority - a.priority;
      // Secondary: earliest executeAfter first
      if (a.executeAfter.getTime() !== b.executeAfter.getTime())
        return a.executeAfter.getTime() - b.executeAfter.getTime();
      // Tertiary: FIFO
      return a.jobId - b.jobId;
    });
}

async function fetchJobsByIds(
  client: DecQueueClient,
  queuePda: PublicKey,
  jobIds: number[]
): Promise<JobRecord[]> {
  const jobs: JobRecord[] = [];
  for (const id of jobIds) {
    const [jobPda] = client.deriveJobPda(queuePda, id);
    try { jobs.push(await client.getJob(jobPda)); } catch { /* missing — skip */ }
  }
  return jobs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// HybridFeeStrategy-aware transaction senders
//
// These replicate the DecQueueClient.claimJob / completeJob / failJob flow but
// intercept the transaction before it is sent so we can prepend ComputeBudget
// instructions and optionally route through Jito.
//
// Why not modify DecQueueClient directly?
//   DecQueueClient uses Anchor's .rpc() method which builds + signs + sends
//   internally. To inject compute budget instructions we use .transaction()
//   instead of .rpc() and pass the resulting Transaction to HybridFeeStrategy.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the raw claim_job transaction instructions (without sending) then
 * dispatch through HybridFeeStrategy with the correct writable accounts for
 * fee estimation.
 */
async function claimWithStrategy(
  client: DecQueueClient,
  strategy: HybridFeeStrategy,
  job: JobRecord,
  queuePda: PublicKey,
  worker: Keypair,
  cluster: Cluster,
  indexPageSeq: number,
  useCompressed: boolean
): Promise<string> {
  const jobPriority = job.priority as JobPriority;

  // Writable accounts for this tx — used for targeted fee estimation.
  // job PDA is write-locked; source_index_page is write-locked.
  const [sourceIndexPage] = client._deriveIndexPagePda(queuePda, indexPageSeq);
  const writableAccounts  = [job.publicKey, sourceIndexPage];

  // Build the instruction list via Anchor's .instruction() path.
  // This gives us the raw TransactionInstruction without submitting.
  let claimIxs: TransactionInstruction[];
  if (useCompressed) {
    // Compressed path: needs proof fetch before we can build ix
    // Fall through to client.claimJob which handles the proof internally
    // and uses .rpc() — we can't inject CU budget without refactoring.
    // Use strategy only for the retry wrapper; the inner call is .rpc().
    return strategy.send(
      [], // empty — we delegate the actual send to the client method below
      writableAccounts,
      jobPriority
    ).then(() =>
      client.claimJob(job.publicKey, queuePda, worker, { useCompressed, cluster, indexPageSeq })
    );
  }

  // Standard path: build instructions from Anchor program object
  claimIxs = [
    await (client.program.methods
      .claimJob()
      .accounts({
        job:              job.publicKey,
        worker:           worker.publicKey,
        sourceIndexPage,
      } as any)
      .instruction())
  ];

  return strategy.send(claimIxs, writableAccounts, jobPriority)
    .then((result) => result.signature);
}

async function completeWithStrategy(
  client: DecQueueClient,
  strategy: HybridFeeStrategy,
  job: JobRecord,
  queuePda: PublicKey,
  worker: Keypair,
  result: string,
  cluster: Cluster,
  useCompressed: boolean
): Promise<string> {
  const jobPriority = job.priority as JobPriority;
  const writableAccounts = [job.publicKey, queuePda];

  if (useCompressed) {
    return client.completeJob(queuePda, job.publicKey, worker, result, { useCompressed, cluster });
  }

  const completeIx = await client.program.methods
    .completeJob(result)
    .accounts({ queue: queuePda, job: job.publicKey, worker: worker.publicKey } as any)
    .instruction();

  return strategy.send([completeIx], writableAccounts, jobPriority)
    .then((r) => r.signature);
}

async function failWithStrategy(
  client: DecQueueClient,
  strategy: HybridFeeStrategy,
  job: JobRecord,
  queuePda: PublicKey,
  worker: Keypair,
  errorMessage: string,
  retryAfterSecs: number,
  cluster: Cluster,
  indexPageSeq: number,
  useCompressed: boolean
): Promise<string> {
  const jobPriority = job.priority as JobPriority;
  const [retryIndexPage] = client._deriveIndexPagePda(queuePda, indexPageSeq);
  const writableAccounts = [job.publicKey, queuePda, retryIndexPage];

  if (useCompressed) {
    return client.failJob(queuePda, job.publicKey, worker, errorMessage, retryAfterSecs, {
      useCompressed, cluster, retryIndexPageSeq: indexPageSeq,
    });
  }

  const failIx = await client.program.methods
    .failJob(errorMessage.slice(0, 128), new (await import("@coral-xyz/anchor")).BN(retryAfterSecs))
    .accounts({ queue: queuePda, job: job.publicKey, worker: worker.publicKey, retryIndexPage } as any)
    .instruction();

  return strategy.send([failIx], writableAccounts, jobPriority)
    .then((r) => r.signature);
}

// ─────────────────────────────────────────────────────────────────────────────
// processReadyJobs — main loop body
// ─────────────────────────────────────────────────────────────────────────────

async function processReadyJobs(
  client: DecQueueClient,
  queuePda: PublicKey,
  worker: Keypair,
  cluster: Cluster,
  strategy: HybridFeeStrategy
): Promise<number> {
  const useCompressed = process.env.DECQUEUE_COMPRESSED === "1";

  // O(1) read — indexes tell us exactly which job_ids are ready
  const readyIds = await client.getReadyJobIds(queuePda);
  if (readyIds.length === 0) return 0;

  const candidateJobs = await fetchJobsByIds(client, queuePda, readyIds);
  const jobs = sortReadyJobs(candidateJobs);  // high priority first
  let processed = 0;

  for (const job of jobs) {
    const indexPageSeq = 0;  // production: read queue_head.head_index_seq

    // ── Claim ──────────────────────────────────────────────────────────────
    let claimSig: string;
    try {
      claimSig = await claimWithStrategy(
        client, strategy, job, queuePda, worker, cluster, indexPageSeq, useCompressed
      );
      console.log(`✓ Claimed  ${jobSummary(job)} → ${formatTxLocation(claimSig, cluster)}`);
    } catch (err) {
      console.warn(`✗ Skipped  ${jobSummary(job)} — claim failed: ${(err as Error).message}`);
      continue;
    }

    // ── Execute (off-chain work) ────────────────────────────────────────────
    let jobResult: string;
    let jobFailed = false;
    let failMessage = "";
    try {
      jobResult = await executeJob(job);
    } catch (err) {
      jobFailed = true;
      failMessage = (err as Error).message.slice(0, 128);
      jobResult = "";
    }

    // ── Complete or Fail ────────────────────────────────────────────────────
    if (!jobFailed) {
      try {
        const completeSig = await completeWithStrategy(
          client, strategy, job, queuePda, worker, jobResult, cluster, useCompressed
        );
        console.log(`✓ Complete ${jobSummary(job)} → ${formatTxLocation(completeSig, cluster)}`);
        processed += 1;
      } catch (err) {
        console.error(`✗ complete_job tx failed after retries: ${(err as Error).message}`);
        // The job is on-chain as Processing but we can't complete it here.
        // The on-chain state is safe — another process can detect stale
        // Processing jobs via a timeout sweep and re-fail them.
      }
    } else {
      try {
        const retryAfterSecs = Number(process.env.DECQUEUE_RETRY_AFTER_SECS ?? 30);
        const failSig = await failWithStrategy(
          client, strategy, job, queuePda, worker,
          failMessage, retryAfterSecs, cluster, indexPageSeq, useCompressed
        );
        console.log(`✗ Failed   ${jobSummary(job)} → ${formatTxLocation(failSig, cluster)} (${failMessage})`);
        processed += 1;
      } catch (err) {
        console.error(`✗ fail_job tx failed after retries: ${(err as Error).message}`);
      }
    }
  }

  return processed;
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const { cluster, queueArg } = parseArgs();
  if (!queueArg) {
    throw new Error(
      "Provide a queue PDA via `npm run worker -- <cluster> <queue-pda>` or DECQUEUE_QUEUE."
    );
  }

  const walletPath    = process.env.WALLET_PATH ?? defaultWalletPath();
  const pollMs        = Number(process.env.DECQUEUE_POLL_MS ?? 5_000);
  const once          = process.env.DECQUEUE_WORKER_ONCE === "1";
  const queuePda      = new PublicKey(queueArg);
  const wallet        = loadWalletFromFile(walletPath);
  const workerKeypair = loadKeypairFromFile(walletPath);
  const client        = await DecQueueClient.connect(wallet, cluster);
  const feeConfig     = buildFeeConfig();

  // ── Build HybridFeeStrategy ───────────────────────────────────────────────
  const strategy = new HybridFeeStrategy(
    client.provider.connection,
    workerKeypair,
    feeConfig
  );

  // ── Print startup banner ──────────────────────────────────────────────────
  const stats = await client.getQueueStats(queuePda);
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║          DecQueue Worker (HybridFeeStrategy)         ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  Cluster:    ${cluster.padEnd(38)}║`);
  console.log(`║  Queue:      ${stats.name.slice(0, 38).padEnd(38)}║`);
  console.log(`║  PDA:        ${queuePda.toBase58().slice(0, 38).padEnd(38)}║`);
  console.log(`║  Wallet:     ${wallet.publicKey.toBase58().slice(0, 38).padEnd(38)}║`);
  console.log(`║  Fee mode:   ${feeConfig.mode.padEnd(38)}║`);
  console.log(`║  Fee pcntile:${String(feeConfig.priorityFeePercentile + "th percentile").padEnd(38)}║`);
  console.log(`║  Jito tip:   ${String(feeConfig.jitoTipLamports + " lamports").padEnd(38)}║`);
  console.log(`║  Retries:    ${String(feeConfig.retry.maxAttempts + " attempts (exp backoff)").padEnd(38)}║`);
  console.log(`║  Mode:       ${(once ? "single pass" : `poll every ${pollMs}ms`).padEnd(38)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  // ── Pre-flight: log current fee landscape ─────────────────────────────────
  try {
    const currentFee = await getDynamicPriorityFee(
      client.provider.connection,
      [queuePda],
      feeConfig
    );
    console.log(`[FeeStrategy] Current estimated priority fee: ${currentFee} µL/CU ` +
                `(${feeConfig.priorityFeePercentile}th percentile)`);
  } catch {
    console.log(`[FeeStrategy] Fee pre-flight skipped (RPC doesn't support getRecentPrioritizationFees)`);
  }

  // ── Event listeners ───────────────────────────────────────────────────────
  const completedListener = await client.onJobCompleted(({ jobId, result }) => {
    console.log(`Event: job #${jobId} completed${result ? ` → ${result}` : ""}`);
  });
  const failedListener = await client.onJobFailed(({ jobId, error, attempts }) => {
    console.log(`Event: job #${jobId} failed on attempt ${attempts}: ${error}`);
  });

  // ── Main poll loop ────────────────────────────────────────────────────────
  try {
    do {
      const processed = await processReadyJobs(client, queuePda, workerKeypair, cluster, strategy);

      if (once) {
        console.log(`\nProcessed ${processed} ready job(s).`);
        break;
      }

      if (processed === 0) {
        process.stdout.write(".");  // quiet dot instead of noisy "No ready jobs"
      } else {
        console.log(`\nProcessed ${processed} job(s) this pass.`);
      }

      await sleep(pollMs);
    } while (true);
  } finally {
    await Promise.all([
      client.removeListener(completedListener),
      client.removeListener(failedListener),
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
