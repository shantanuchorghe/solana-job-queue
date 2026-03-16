import { PublicKey } from "@solana/web3.js";
import {
  Cluster,
  JobRecord,
  SolQueueClient,
  defaultWalletPath,
  formatAddressLocation,
  formatTxLocation,
  loadKeypairFromFile,
  loadWalletFromFile,
} from "./index";

const VALID_CLUSTERS = new Set<Cluster>(["localnet", "devnet", "mainnet-beta"]);

function parseCluster(value: string | undefined): Cluster | null {
  if (!value) {
    return null;
  }

  return VALID_CLUSTERS.has(value as Cluster) ? (value as Cluster) : null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  let cluster = parseCluster(process.env.SOLQUEUE_CLUSTER) ?? "localnet";

  for (const arg of args) {
    const parsedCluster = parseCluster(arg);
    if (parsedCluster) {
      cluster = parsedCluster;
      continue;
    }

    positional.push(arg);
  }

  return {
    cluster,
    queueArg: positional[0] ?? process.env.SOLQUEUE_QUEUE,
  };
}

function jobSummary(job: JobRecord): string {
  return `#${job.jobId} ${job.jobType} [${job.status}]`;
}

function compactJson(value: unknown): string {
  return JSON.stringify(value).slice(0, 120);
}

function renderResult(job: JobRecord): string {
  const payload = job.payload as Record<string, unknown>;

  switch (job.jobType) {
    case "send-email":
      return compactJson({
        ok: true,
        to: payload.to ?? "unknown",
        ref: `msg_${job.jobId.toString(36)}`,
      });
    case "webhook-call":
      return compactJson({
        ok: true,
        target: payload.url ?? "unknown",
        code: 202,
      });
    case "image-resize":
      return compactJson({
        ok: true,
        asset: payload.imageId ?? `img_${job.jobId}`,
        variant: "thumbnail",
      });
    case "daily-report":
      return compactJson({
        ok: true,
        report: payload.reportId ?? `report_${job.jobId}`,
      });
    case "audit-log":
      return compactJson({
        ok: true,
        entry: `audit_${job.jobId}`,
      });
    default:
      return compactJson({
        ok: true,
        handledBy: "solqueue-worker",
        type: job.jobType,
      });
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
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }

      if (left.executeAfter.getTime() !== right.executeAfter.getTime()) {
        return left.executeAfter.getTime() - right.executeAfter.getTime();
      }

      return left.jobId - right.jobId;
    });
}

async function processReadyJobs(
  client: SolQueueClient,
  queuePda: PublicKey,
  worker = loadKeypairFromFile(process.env.WALLET_PATH ?? defaultWalletPath()),
  cluster: Cluster
): Promise<number> {
  const jobs = sortReadyJobs(await client.getAllJobs(queuePda));
  let processed = 0;

  for (const job of jobs) {
    try {
      const claimSignature = await client.claimJob(job.publicKey, worker);
      console.log(`Claimed ${jobSummary(job)} -> ${formatTxLocation(claimSignature, cluster)}`);
    } catch (error) {
      console.warn(`Skipped ${jobSummary(job)} because claim failed: ${(error as Error).message}`);
      continue;
    }

    try {
      const result = await executeJob(job);
      const completeSignature = await client.completeJob(queuePda, job.publicKey, worker, result);
      console.log(`Completed ${jobSummary(job)} -> ${formatTxLocation(completeSignature, cluster)}`);
      processed += 1;
    } catch (error) {
      const message = (error as Error).message.slice(0, 128);
      const failSignature = await client.failJob(queuePda, job.publicKey, worker, message, Number(process.env.SOLQUEUE_RETRY_AFTER_SECS ?? 30));
      console.log(`Failed ${jobSummary(job)} -> ${formatTxLocation(failSignature, cluster)} (${message})`);
      processed += 1;
    }
  }

  return processed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { cluster, queueArg } = parseArgs();
  if (!queueArg) {
    throw new Error("Provide a queue PDA via `npm run worker -- <cluster> <queue-pda>` or SOLQUEUE_QUEUE.");
  }

  const walletPath = process.env.WALLET_PATH ?? defaultWalletPath();
  const pollMs = Number(process.env.SOLQUEUE_POLL_MS ?? 5000);
  const once = process.env.SOLQUEUE_WORKER_ONCE === "1";
  const queuePda = new PublicKey(queueArg);
  const wallet = loadWalletFromFile(walletPath);
  const workerKeypair = loadKeypairFromFile(walletPath);
  const client = await SolQueueClient.connect(wallet, cluster);
  const stats = await client.getQueueStats(queuePda);

  console.log(`Worker connected to ${cluster}`);
  console.log(`Queue:  ${stats.name}`);
  console.log(`PDA:    ${formatAddressLocation(queuePda.toBase58(), cluster)}`);
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Mode:   ${once ? "single pass" : `poll every ${pollMs}ms`}`);

  const completedListener = await client.onJobCompleted(({ jobId, result }) => {
    console.log(`Event: job #${jobId} completed${result ? ` -> ${result}` : ""}`);
  });
  const failedListener = await client.onJobFailed(({ jobId, error, attempts }) => {
    console.log(`Event: job #${jobId} failed on attempt ${attempts}: ${error}`);
  });

  try {
    do {
      const processed = await processReadyJobs(client, queuePda, workerKeypair, cluster);
      if (once) {
        console.log(`Processed ${processed} ready job(s).`);
        break;
      }

      if (processed === 0) {
        console.log("No ready jobs found.");
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
