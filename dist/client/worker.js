"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
const web3_js_1 = require("@solana/web3.js");
const index_1 = require("./index");
const fee_strategy_1 = require("./fee-strategy");
// ─────────────────────────────────────────────────────────────────────────────
// Config helpers
// ─────────────────────────────────────────────────────────────────────────────
const VALID_CLUSTERS = new Set(["localnet", "devnet", "mainnet-beta"]);
function parseCluster(value) {
    if (!value)
        return null;
    return VALID_CLUSTERS.has(value) ? value : null;
}
function parseArgs() {
    var _a, _b;
    const args = process.argv.slice(2);
    const positional = [];
    let cluster = (_a = parseCluster(process.env.DECQUEUE_CLUSTER)) !== null && _a !== void 0 ? _a : "localnet";
    for (const arg of args) {
        const parsedCluster = parseCluster(arg);
        if (parsedCluster) {
            cluster = parsedCluster;
            continue;
        }
        positional.push(arg);
    }
    return { cluster, queueArg: (_b = positional[0]) !== null && _b !== void 0 ? _b : process.env.DECQUEUE_QUEUE };
}
/** Build HybridFeeStrategyConfig from environment variables */
function buildFeeConfig() {
    var _a, _b;
    const modeEnv = process.env.DECQUEUE_FEE_MODE;
    const validModes = ["standard", "jito", "auto"];
    const mode = validModes.includes(modeEnv) ? modeEnv : "auto";
    return (0, fee_strategy_1.defaultHybridFeeConfig)({
        mode,
        priorityFeePercentile: Number((_a = process.env.DECQUEUE_PRIORITY_FEE_PERCENTILE) !== null && _a !== void 0 ? _a : 75),
        retry: {
            maxAttempts: Number((_b = process.env.DECQUEUE_MAX_SEND_ATTEMPTS) !== null && _b !== void 0 ? _b : 4),
            baseDelayMs: 800,
            jitterFactor: 0.2,
            backoffMultiplier: 2.0,
        },
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Job utilities
// ─────────────────────────────────────────────────────────────────────────────
function jobSummary(job) {
    var _a;
    const priorityLabel = (_a = ["low", "normal", "high"][job.priority]) !== null && _a !== void 0 ? _a : job.priority;
    return `#${job.jobId} ${job.jobType} [${job.status}] (${priorityLabel})`;
}
function compactJson(value) {
    return JSON.stringify(value).slice(0, 120);
}
function renderResult(job) {
    var _a, _b, _c, _d;
    const payload = job.payload;
    switch (job.jobType) {
        case "send-email":
            return compactJson({ ok: true, to: (_a = payload.to) !== null && _a !== void 0 ? _a : "unknown", ref: `msg_${job.jobId.toString(36)}` });
        case "webhook-call":
            return compactJson({ ok: true, target: (_b = payload.url) !== null && _b !== void 0 ? _b : "unknown", code: 202 });
        case "image-resize":
            return compactJson({ ok: true, asset: (_c = payload.imageId) !== null && _c !== void 0 ? _c : `img_${job.jobId}`, variant: "thumbnail" });
        case "daily-report":
            return compactJson({ ok: true, report: (_d = payload.reportId) !== null && _d !== void 0 ? _d : `report_${job.jobId}` });
        case "audit-log":
            return compactJson({ ok: true, entry: `audit_${job.jobId}` });
        default:
            return compactJson({ ok: true, handledBy: "decqueue-worker", type: job.jobType });
    }
}
function executeJob(job) {
    return __awaiter(this, void 0, void 0, function* () {
        const payload = job.payload;
        if (payload.fail === true || payload.shouldFail === true || payload.simulateFailure === true) {
            throw new Error("Job payload requested a simulated failure");
        }
        if (typeof payload.throwMessage === "string" && payload.throwMessage.trim().length > 0) {
            throw new Error(payload.throwMessage.trim());
        }
        return renderResult(job);
    });
}
function sortReadyJobs(jobs) {
    return jobs
        .filter((job) => job.status === "pending" && job.executeAfter.getTime() <= Date.now())
        .sort((a, b) => {
        // Primary: priority desc (high=2 first)
        if (a.priority !== b.priority)
            return b.priority - a.priority;
        // Secondary: earliest executeAfter first
        if (a.executeAfter.getTime() !== b.executeAfter.getTime())
            return a.executeAfter.getTime() - b.executeAfter.getTime();
        // Tertiary: FIFO
        return a.jobId - b.jobId;
    });
}
function fetchJobsByIds(client, queuePda, jobIds) {
    return __awaiter(this, void 0, void 0, function* () {
        const jobs = [];
        for (const id of jobIds) {
            const [jobPda] = client.deriveJobPda(queuePda, id);
            try {
                jobs.push(yield client.getJob(jobPda));
            }
            catch ( /* missing — skip */_a) { /* missing — skip */ }
        }
        return jobs;
    });
}
function sleep(ms) {
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
function claimWithStrategy(client, strategy, job, queuePda, worker, cluster, indexPageSeq, useCompressed) {
    return __awaiter(this, void 0, void 0, function* () {
        const jobPriority = job.priority;
        // Writable accounts for this tx — used for targeted fee estimation.
        // job PDA is write-locked; source_index_page is write-locked.
        const [sourceIndexPage] = client._deriveIndexPagePda(queuePda, indexPageSeq);
        const writableAccounts = [job.publicKey, sourceIndexPage];
        // Build the instruction list via Anchor's .instruction() path.
        // This gives us the raw TransactionInstruction without submitting.
        let claimIxs;
        if (useCompressed) {
            // Compressed path: needs proof fetch before we can build ix
            // Fall through to client.claimJob which handles the proof internally
            // and uses .rpc() — we can't inject CU budget without refactoring.
            // Use strategy only for the retry wrapper; the inner call is .rpc().
            return strategy.send([], // empty — we delegate the actual send to the client method below
            writableAccounts, jobPriority).then(() => client.claimJob(job.publicKey, queuePda, worker, { useCompressed, cluster, indexPageSeq }));
        }
        // Standard path: build instructions from Anchor program object
        claimIxs = [
            yield (client.program.methods
                .claimJob()
                .accounts({
                job: job.publicKey,
                worker: worker.publicKey,
                sourceIndexPage,
            })
                .instruction())
        ];
        return strategy.send(claimIxs, writableAccounts, jobPriority)
            .then((result) => result.signature);
    });
}
function completeWithStrategy(client, strategy, job, queuePda, worker, result, cluster, useCompressed) {
    return __awaiter(this, void 0, void 0, function* () {
        const jobPriority = job.priority;
        const writableAccounts = [job.publicKey, queuePda];
        if (useCompressed) {
            return client.completeJob(queuePda, job.publicKey, worker, result, { useCompressed, cluster });
        }
        const completeIx = yield client.program.methods
            .completeJob(result)
            .accounts({ queue: queuePda, job: job.publicKey, worker: worker.publicKey })
            .instruction();
        return strategy.send([completeIx], writableAccounts, jobPriority)
            .then((r) => r.signature);
    });
}
function failWithStrategy(client, strategy, job, queuePda, worker, errorMessage, retryAfterSecs, cluster, indexPageSeq, useCompressed) {
    return __awaiter(this, void 0, void 0, function* () {
        const jobPriority = job.priority;
        const [retryIndexPage] = client._deriveIndexPagePda(queuePda, indexPageSeq);
        const writableAccounts = [job.publicKey, queuePda, retryIndexPage];
        if (useCompressed) {
            return client.failJob(queuePda, job.publicKey, worker, errorMessage, retryAfterSecs, {
                useCompressed, cluster, retryIndexPageSeq: indexPageSeq,
            });
        }
        const failIx = yield client.program.methods
            .failJob(errorMessage.slice(0, 128), new (yield Promise.resolve().then(() => __importStar(require("@coral-xyz/anchor")))).BN(retryAfterSecs))
            .accounts({ queue: queuePda, job: job.publicKey, worker: worker.publicKey, retryIndexPage })
            .instruction();
        return strategy.send([failIx], writableAccounts, jobPriority)
            .then((r) => r.signature);
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// processReadyJobs — main loop body
// ─────────────────────────────────────────────────────────────────────────────
function processReadyJobs(client, queuePda, worker, cluster, strategy) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const useCompressed = process.env.DECQUEUE_COMPRESSED === "1";
        // O(1) read — indexes tell us exactly which job_ids are ready
        const readyIds = yield client.getReadyJobIds(queuePda);
        if (readyIds.length === 0)
            return 0;
        const candidateJobs = yield fetchJobsByIds(client, queuePda, readyIds);
        const jobs = sortReadyJobs(candidateJobs); // high priority first
        let processed = 0;
        for (const job of jobs) {
            const indexPageSeq = 0; // production: read queue_head.head_index_seq
            // ── Claim ──────────────────────────────────────────────────────────────
            let claimSig;
            try {
                claimSig = yield claimWithStrategy(client, strategy, job, queuePda, worker, cluster, indexPageSeq, useCompressed);
                console.log(`✓ Claimed  ${jobSummary(job)} → ${(0, index_1.formatTxLocation)(claimSig, cluster)}`);
            }
            catch (err) {
                console.warn(`✗ Skipped  ${jobSummary(job)} — claim failed: ${err.message}`);
                continue;
            }
            // ── Execute (off-chain work) ────────────────────────────────────────────
            let jobResult;
            let jobFailed = false;
            let failMessage = "";
            try {
                jobResult = yield executeJob(job);
            }
            catch (err) {
                jobFailed = true;
                failMessage = err.message.slice(0, 128);
                jobResult = "";
            }
            // ── Complete or Fail ────────────────────────────────────────────────────
            if (!jobFailed) {
                try {
                    const completeSig = yield completeWithStrategy(client, strategy, job, queuePda, worker, jobResult, cluster, useCompressed);
                    console.log(`✓ Complete ${jobSummary(job)} → ${(0, index_1.formatTxLocation)(completeSig, cluster)}`);
                    processed += 1;
                }
                catch (err) {
                    console.error(`✗ complete_job tx failed after retries: ${err.message}`);
                    // The job is on-chain as Processing but we can't complete it here.
                    // The on-chain state is safe — another process can detect stale
                    // Processing jobs via a timeout sweep and re-fail them.
                }
            }
            else {
                try {
                    const retryAfterSecs = Number((_a = process.env.DECQUEUE_RETRY_AFTER_SECS) !== null && _a !== void 0 ? _a : 30);
                    const failSig = yield failWithStrategy(client, strategy, job, queuePda, worker, failMessage, retryAfterSecs, cluster, indexPageSeq, useCompressed);
                    console.log(`✗ Failed   ${jobSummary(job)} → ${(0, index_1.formatTxLocation)(failSig, cluster)} (${failMessage})`);
                    processed += 1;
                }
                catch (err) {
                    console.error(`✗ fail_job tx failed after retries: ${err.message}`);
                }
            }
        }
        return processed;
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const { cluster, queueArg } = parseArgs();
        if (!queueArg) {
            throw new Error("Provide a queue PDA via `npm run worker -- <cluster> <queue-pda>` or DECQUEUE_QUEUE.");
        }
        const walletPath = (_a = process.env.WALLET_PATH) !== null && _a !== void 0 ? _a : (0, index_1.defaultWalletPath)();
        const pollMs = Number((_b = process.env.DECQUEUE_POLL_MS) !== null && _b !== void 0 ? _b : 5000);
        const once = process.env.DECQUEUE_WORKER_ONCE === "1";
        const queuePda = new web3_js_1.PublicKey(queueArg);
        const wallet = (0, index_1.loadWalletFromFile)(walletPath);
        const workerKeypair = (0, index_1.loadKeypairFromFile)(walletPath);
        const client = yield index_1.DecQueueClient.connect(wallet, cluster);
        const feeConfig = buildFeeConfig();
        // ── Build HybridFeeStrategy ───────────────────────────────────────────────
        const strategy = new fee_strategy_1.HybridFeeStrategy(client.provider.connection, workerKeypair, feeConfig);
        // ── Print startup banner ──────────────────────────────────────────────────
        const stats = yield client.getQueueStats(queuePda);
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
            const currentFee = yield (0, fee_strategy_1.getDynamicPriorityFee)(client.provider.connection, [queuePda], feeConfig);
            console.log(`[FeeStrategy] Current estimated priority fee: ${currentFee} µL/CU ` +
                `(${feeConfig.priorityFeePercentile}th percentile)`);
        }
        catch (_c) {
            console.log(`[FeeStrategy] Fee pre-flight skipped (RPC doesn't support getRecentPrioritizationFees)`);
        }
        // ── Event listeners ───────────────────────────────────────────────────────
        const completedListener = yield client.onJobCompleted(({ jobId, result }) => {
            console.log(`Event: job #${jobId} completed${result ? ` → ${result}` : ""}`);
        });
        const failedListener = yield client.onJobFailed(({ jobId, error, attempts }) => {
            console.log(`Event: job #${jobId} failed on attempt ${attempts}: ${error}`);
        });
        // ── Main poll loop ────────────────────────────────────────────────────────
        try {
            do {
                const processed = yield processReadyJobs(client, queuePda, workerKeypair, cluster, strategy);
                if (once) {
                    console.log(`\nProcessed ${processed} ready job(s).`);
                    break;
                }
                if (processed === 0) {
                    process.stdout.write("."); // quiet dot instead of noisy "No ready jobs"
                }
                else {
                    console.log(`\nProcessed ${processed} job(s) this pass.`);
                }
                yield sleep(pollMs);
            } while (true);
        }
        finally {
            yield Promise.all([
                client.removeListener(completedListener),
                client.removeListener(failedListener),
            ]);
        }
    });
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
