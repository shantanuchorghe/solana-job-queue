/**
 * fee-strategy.ts — HybridFeeStrategy for SolQueue workers
 *
 * Solana under congestion drops transactions that aren't competitive for block
 * inclusion. Two mechanisms fight this:
 *
 *   1. Priority Fees (ComputeBudgetProgram.setComputeUnitPrice)
 *      — A per-CU micro-lamport bid, sorted by validators when packing blocks.
 *      — getRecentPrioritizationFees returns the 150-slot distribution across
 *        all accounts your tx will write-lock, so the bid is targeted, not global.
 *
 *   2. Jito Bundles (via Jito block engine API)
 *      — A bundle is a group of up to 5 transactions sent atomically to a Jito
 *        validator. The winning bundle is the one with the highest SOL tip to
 *        the Jito tip account.
 *      — Bundles have a HARD guarantee: either ALL txs land or NONE do.
 *        This is stronger than normal tx sending and eliminates the "claim
 *        landed but complete dropped" failure mode.
 *      — Tip ONLY goes to Jito, not the validator, so it's additive to the
 *        standard priority fee.
 *
 * HybridFeeStrategy lets you toggle between:
 *   - "standard"  → priority fee only (works on any RPC, any validator)
 *   - "jito"      → bundle with Jito tip (needs a Jito-enabled RPC endpoint)
 *   - "auto"      → start with Jito, fall back to standard on retry N>=1
 *
 * Key design decisions:
 *   - Priority fee is re-fetched each attempt so stale fee estimates never
 *     persist across retries (a 5-second retry delay changes the fee landscape)
 *   - Jito tip is NOT applied on retries where the job dropped below
 *     high-priority (priority < 2), because the tip cost exceeds the speed
 *     benefit for low-priority work
 *   - Backoff is exponential with jitter (±20%) to avoid thundering-herd
 *     when many workers retry simultaneously
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  sendAndConfirmRawTransaction,
  sendAndConfirmTransaction,
  VersionedTransaction,
} from "@solana/web3.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Job priority level — matches the on-chain u8 field (0=low, 1=normal, 2=high) */
export type JobPriority = 0 | 1 | 2;

export type FeeMode = "standard" | "jito" | "auto";

/** Full configuration for the hybrid fee strategy. */
export interface HybridFeeStrategyConfig {
  /**
   * mode:
   *   "standard" — use getRecentPrioritizationFees + ComputeBudgetProgram only.
   *   "jito"     — always send via Jito bundle with a lamport tip.
   *   "auto"     — attempt Jito on first try; fall back to standard on retry.
   */
  mode: FeeMode;

  /**
   * Jito block engine REST endpoint.
   * Default: devnet block engine. Override with JITO_BLOCK_ENGINE_URL env var.
   *
   * Devnet:   https://ny.mainnet.block-engine.jito.wtf   (use regional endpoint)
   * Mainnet endpoints: https://jito-labs.gitbook.io/mev/systems/block-engine/endpoints
   */
  jitoBlockEngineUrl: string;

  /**
   * Tip amount to send to the Jito tip account, in lamports.
   * Competitive tip on mainnet is typically 10_000–100_000 lamports (0.00001–0.0001 SOL).
   * Set to 0 to disable tipping while still using the bundle API.
   */
  jitoTipLamports: number;

  /**
   * Whether to skip the Jito tip on retries for non-high-priority jobs.
   * When true (default), retries where job.priority < 2 use the standard path.
   */
  skipJitoTipOnLowPriorityRetry: boolean;

  /**
   * Compute unit budget for transactions.
   * SolQueue instructions use well under 200k CU — 80k is a safe ceiling.
   */
  computeUnitLimit: number;

  /**
   * Percentile of recent prioritization fees to use (0–100).
   *  50 = median  → cost-efficient, occasionally slow under spike congestion
   *  75 = 75th p. → recommended for worker claim transactions
   *  90 = 90th p. → fast landing but higher cost
   */
  priorityFeePercentile: number;

  /**
   * Minimum micro-lamports/CU to bid even if the network is idle (floor).
   * Prevents free-riding on a clean chain where getRecentPrioritizationFees = 0.
   */
  minPriorityFeeMicroLamports: number;

  /**
   * Maximum micro-lamports/CU cap — prevents runaway bids during fee spikes.
   */
  maxPriorityFeeMicroLamports: number;

  /** Retry configuration */
  retry: {
    /** Max total attempts (first try + this many retries) */
    maxAttempts: number;
    /** Base delay in ms for exponential backoff */
    baseDelayMs: number;
    /** Jitter factor (0–1). 0.2 = ±20% on each delay */
    jitterFactor: number;
    /** Multiply base delay by this on each retry (standard backoff is 2.0) */
    backoffMultiplier: number;
  };
}

/** Result of a successful send */
export interface SendResult {
  signature: string;
  /** Which attempt succeeded (1 = first try, 2 = first retry, …) */
  attempt: number;
  /** Fee mode actually used for the successful attempt */
  modeUsed: FeeMode;
  /** Priority fee in micro-lamports/CU that was applied */
  priorityFeeMicroLamports: number;
  /** Whether a Jito tip was paid */
  jitoTipPaid: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical Jito tip accounts — one is randomly picked per bundle to distribute
 * tip revenue evenly across the Jito tip pool.
 * Source: https://jito-labs.gitbook.io/mev/systems/bundles/tip-payment
 */
export const JITO_TIP_ACCOUNTS: PublicKey[] = [
  new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
  new PublicKey("HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe"),
  new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"),
  new PublicKey("ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13mb5xPJ"),
  new PublicKey("DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"),
  new PublicKey("ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt"),
  new PublicKey("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"),
  new PublicKey("3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"),
];

/** Pick a random Jito tip account to spread revenue across the tip pool */
function randomJitoTipAccount(): PublicKey {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Default configuration
// ─────────────────────────────────────────────────────────────────────────────

export function defaultHybridFeeConfig(
  overrides: Partial<HybridFeeStrategyConfig> = {}
): HybridFeeStrategyConfig {
  return {
    mode:                        "auto",
    jitoBlockEngineUrl:          process.env.JITO_BLOCK_ENGINE_URL
                                   ?? "https://ny.mainnet.block-engine.jito.wtf",
    jitoTipLamports:             Number(process.env.JITO_TIP_LAMPORTS ?? 25_000),
    skipJitoTipOnLowPriorityRetry: true,
    computeUnitLimit:            80_000,
    priorityFeePercentile:       75,
    minPriorityFeeMicroLamports: 1_000,          // 1 micro-lamport/CU floor
    maxPriorityFeeMicroLamports: 5_000_000,      // 5 lamports/CU hard cap
    retry: {
      maxAttempts:        4,
      baseDelayMs:        800,
      jitterFactor:       0.2,
      backoffMultiplier:  2.0,
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Priority fee calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the recent prioritization fee distribution for a set of write-locked
 * accounts and return the Nth-percentile micro-lamports/CU bid.
 *
 * `getRecentPrioritizationFees` returns up to 150 data points (one per recent
 * slot) filtered to slots where AT LEAST ONE of the given accounts was
 * write-locked. This gives a better signal than the global median because it
 * reflects the actual competition for YOUR specific tx's locked accounts.
 *
 * Example: if jobs on queue Q are highly contested, Q's lock will have a
 * higher fee distribution than the global average.
 */
export async function getDynamicPriorityFee(
  connection: Connection,
  writableAccounts: PublicKey[],
  config: Pick<
    HybridFeeStrategyConfig,
    | "priorityFeePercentile"
    | "minPriorityFeeMicroLamports"
    | "maxPriorityFeeMicroLamports"
  >
): Promise<number> {
  let fees: number[] = [];

  try {
    // Returns: Array<{ slot: number; prioritizationFee: number }>
    // One entry per recent slot where the given accounts were write-locked.
    const recentFees = await connection.getRecentPrioritizationFees({
      lockedWritableAccounts: writableAccounts,
    });

    fees = recentFees
      .map((f) => f.prioritizationFee)
      .filter((f) => f > 0)         // 0-fee slots are idle network artefacts
      .sort((a, b) => a - b);
  } catch (err) {
    // RPC might not support this method on old endpoints — fall back to floor
    console.warn(`[FeeStrategy] getRecentPrioritizationFees failed: ${(err as Error).message}`);
  }

  if (fees.length === 0) {
    return config.minPriorityFeeMicroLamports;
  }

  // Compute the percentile value
  const idx = Math.floor((config.priorityFeePercentile / 100) * (fees.length - 1));
  const percentileFee = fees[idx];

  // Apply floor and cap
  return Math.max(
    config.minPriorityFeeMicroLamports,
    Math.min(config.maxPriorityFeeMicroLamports, percentileFee)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Compute budget instructions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the two ComputeBudgetProgram instructions that should prefix every tx:
 *   1. setComputeUnitLimit — avoids paying for unused CUs
 *   2. setComputeUnitPrice — the micro-lamport/CU bid for block inclusion
 */
export function buildComputeBudgetInstructions(
  computeUnitLimit: number,
  microLamportsPerCu: number
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerCu }),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Jito bundle sender
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a group of instructions as a Jito bundle.
 *
 * A Jito bundle is sent to the Jito block engine as a JSON-RPC call
 * (`sendBundle`). The block engine forwards it to the leader Jito validators.
 * If the current leader is NOT running Jito, the bundle is dropped — hence
 * the retry fallback to standard.
 *
 * Bundle anatomy:
 *   tx[0]: tip transaction — SOL transfer from payer to a Jito tip account
 *   tx[1...]: the actual program instructions (up to 4 more transactions)
 *
 * Why a separate tip tx instead of a tip memo?
 *   Jito requires the tip to be a pure SOL transfer so validators can
 *   trivially compute the bundle value without executing the program.
 *
 * @param connection   Solana RPC connection (used to get blockhash + simulate)
 * @param payer        Keypair that pays for fees and the tip transfer
 * @param instructions The actual program instructions to execute
 * @param tipLamports  Tip amount in lamports (competitive = 10k–100k)
 * @param blockEngineUrl  Jito block engine JSON-RPC URL
 * @returns Bundle UUID (not a tx signature — bundles have their own IDs)
 */
export async function sendWithJito(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  tipLamports: number,
  blockEngineUrl: string
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  // ── Build tip transaction ─────────────────────────────────────────────────
  // Must be a simple SOL SystemProgram.transfer to a known Jito tip account.
  const tipIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey:   randomJitoTipAccount(),
    lamports:   tipLamports,
  });

  const tipTx = new Transaction().add(tipIx);
  tipTx.recentBlockhash = blockhash;
  tipTx.feePayer = payer.publicKey;
  tipTx.sign(payer);

  // ── Build program transaction ─────────────────────────────────────────────
  const programTx = new Transaction().add(...instructions);
  programTx.recentBlockhash = blockhash;
  programTx.feePayer = payer.publicKey;
  programTx.sign(payer);

  // ── Serialize both transactions ───────────────────────────────────────────
  const encodedTipTx      = tipTx.serialize().toString("base64");
  const encodedProgramTx  = programTx.serialize().toString("base64");

  // ── POST to Jito block engine's sendBundle JSON-RPC endpoint ─────────────
  // API reference: https://jito-labs.gitbook.io/mev/systems/bundles/json-rpc-api
  const response = await fetch(`${blockEngineUrl}/api/v1/bundles`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method:  "sendBundle",
      params: [
        [encodedTipTx, encodedProgramTx],   // tip MUST be tx[0]
        { encoding: "base64" },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Jito sendBundle HTTP ${response.status}: ${await response.text()}`
    );
  }

  const body = await response.json() as { result?: string; error?: { message: string } };

  if (body.error) {
    throw new Error(`Jito sendBundle RPC error: ${body.error.message}`);
  }

  // The result is a bundle UUID (not a Solana tx signature).
  // Poll getBundleStatuses to confirm landing or fall back after timeout.
  const bundleId = body.result!;
  await confirmJitoBundle(blockEngineUrl, bundleId, lastValidBlockHeight);

  // Return the program tx signature so callers can link to explorer.
  // (The bundle UUID is not directly viewable on standard explorers.)
  return programTx.signatures[0]?.signature?.toString("base64") ?? bundleId;
}

/**
 * Poll Jito's `getBundleStatuses` until the bundle lands or exceeds
 * `lastValidBlockHeight` (= blockhash expires = definitely dropped).
 */
async function confirmJitoBundle(
  blockEngineUrl: string,
  bundleId: string,
  lastValidBlockHeight: number,
  pollIntervalMs = 1_500,
  maxPollMs = 30_000
): Promise<void> {
  const deadline = Date.now() + maxPollMs;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);

    const resp = await fetch(`${blockEngineUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [[bundleId]],
      }),
    });

    if (!resp.ok) continue;

    const body = await resp.json() as {
      result?: { value?: Array<{ confirmation_status?: string; err?: unknown }> }
    };

    const status = body.result?.value?.[0];
    if (!status) continue;

    if (status.err) {
      throw new Error(`Jito bundle failed on-chain: ${JSON.stringify(status.err)}`);
    }

    const confirmed =
      status.confirmation_status === "confirmed" ||
      status.confirmation_status === "finalized";

    if (confirmed) return;
  }

  throw new Error(
    `Jito bundle ${bundleId} not confirmed within ${maxPollMs}ms — ` +
    "it may have been dropped (no Jito leader in window). Will retry with standard."
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Exponential backoff helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the next retry delay with exponential backoff and jitter.
 *
 *   delay = baseMs * multiplier^(attempt-1) * (1 ± jitterFactor)
 *
 * Example with defaults (base=800ms, mult=2.0, jitter=0.2):
 *   Attempt 1 → 800ms  * (0.8–1.2) = 640–960ms
 *   Attempt 2 → 1600ms * (0.8–1.2) = 1280–1920ms
 *   Attempt 3 → 3200ms * (0.8–1.2) = 2560–3840ms
 *
 * The ±jitter prevents thundering herd: if 20 workers all retry at exactly
 * the same time they'll compete for the same slot. Jitter spreads them out.
 */
export function backoffDelayMs(
  attempt: number,   // 1-indexed (attempt=1 = first retry, after first failure)
  config: HybridFeeStrategyConfig["retry"]
): number {
  const base       = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
  const jitter     = base * config.jitterFactor * (Math.random() * 2 - 1); // ±jitter
  return Math.max(0, Math.round(base + jitter));
}

// ─────────────────────────────────────────────────────────────────────────────
// HybridFeeStrategy — main orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HybridFeeStrategy wraps transaction sending with:
 *   1. Dynamic priority fee from getRecentPrioritizationFees
 *   2. Optional Jito bundle on first attempt (configurable)
 *   3. Exponential backoff retry with intelligent mode downgrade
 *
 * Usage:
 * ```ts
 * const strategy = new HybridFeeStrategy(connection, payer, config);
 *
 * const result = await strategy.send(
 *   instructions,
 *   writableAccounts,   // for targeted fee estimation
 *   job.priority        // drives Jito tip skip decision on retry
 * );
 * console.log(`Landed on attempt ${result.attempt}, fee=${result.priorityFeeMicroLamports} µL/CU`);
 * ```
 */
export class HybridFeeStrategy {
  constructor(
    public readonly connection: Connection,
    public readonly payer: Keypair,
    public readonly config: HybridFeeStrategyConfig
  ) {}

  /**
   * Send a set of instructions with automatic fee calculation and retry.
   *
   * @param instructions  The program instructions to send (WITHOUT ComputeBudget
   *                      prefixes — this method adds them).
   * @param writableAccounts  Accounts that will be write-locked by the tx.
   *                          Used for targeted fee estimation.
   * @param jobPriority   0, 1, or 2. Controls whether Jito tips are skipped
   *                      on retries for non-high-priority jobs.
   */
  async send(
    instructions: TransactionInstruction[],
    writableAccounts: PublicKey[],
    jobPriority: JobPriority = 1
  ): Promise<SendResult> {
    const { retry, mode, skipJitoTipOnLowPriorityRetry } = this.config;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      // ── 1. Calculate dynamic priority fee ──────────────────────────────────
      const microLamportsPerCu = await getDynamicPriorityFee(
        this.connection,
        writableAccounts,
        this.config
      );

      // ── 2. Determine fee mode for this attempt ────────────────────────────
      //
      // "auto" strategy:
      //   - Attempt 1            → use Jito (fastest landing under congestion)
      //   - Attempt 2+ (any job) → standard  (Jito bundle missed the window)
      //
      // Additionally, if skipJitoTipOnLowPriorityRetry AND job.priority < 2:
      //   - Always use standard (tip cost isn't worth it for low-priority work)
      const isHighPriority  = jobPriority >= 2;
      const isJitoAttempt   =
        mode === "jito" ||
        (mode === "auto" && attempt === 1) ;

      const skipJitoForPriority =
        skipJitoTipOnLowPriorityRetry && !isHighPriority && attempt > 1;

      const useJito = isJitoAttempt && !skipJitoForPriority;
      const modeUsed: FeeMode = useJito ? "jito" : "standard";

      // ── 3. Build compute budget prefix ─────────────────────────────────────
      const budgetIxs = buildComputeBudgetInstructions(
        this.config.computeUnitLimit,
        microLamportsPerCu
      );
      const fullInstructions = [...budgetIxs, ...instructions];

      try {
        let signature: string;

        if (useJito) {
          // ── 3a. Jito path: bundle tip tx + program tx ─────────────────────
          console.log(
            `[FeeStrategy] Attempt ${attempt}/${retry.maxAttempts} — Jito bundle | ` +
            `tip=${this.config.jitoTipLamports}L | fee=${microLamportsPerCu}µL/CU`
          );

          signature = await sendWithJito(
            this.connection,
            this.payer,
            fullInstructions,
            this.config.jitoTipLamports,
            this.config.jitoBlockEngineUrl
          );
        } else {
          // ── 3b. Standard path: build + sign + sendAndConfirmTransaction ──
          console.log(
            `[FeeStrategy] Attempt ${attempt}/${retry.maxAttempts} — Standard | ` +
            `fee=${microLamportsPerCu}µL/CU | priority=${jobPriority}`
          );

          const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
          const tx = new Transaction().add(...fullInstructions);
          tx.recentBlockhash = blockhash;
          tx.feePayer = this.payer.publicKey;

          signature = await sendAndConfirmTransaction(
            this.connection,
            tx,
            [this.payer],
            { commitment: "confirmed", skipPreflight: false }
          );
        }

        console.log(
          `[FeeStrategy] ✓ Confirmed on attempt ${attempt} | sig=${signature.slice(0, 16)}... | ` +
          `mode=${modeUsed} | fee=${microLamportsPerCu}µL/CU | jitoTip=${useJito}`
        );

        return {
          signature,
          attempt,
          modeUsed,
          priorityFeeMicroLamports: microLamportsPerCu,
          jitoTipPaid: useJito,
        };
      } catch (err) {
        lastError = err as Error;
        const delay = backoffDelayMs(attempt, retry);

        console.warn(
          `[FeeStrategy] ✗ Attempt ${attempt} failed (${lastError.message.slice(0, 80)}). ` +
          (attempt < retry.maxAttempts
            ? `Retrying in ${delay}ms...`
            : "All attempts exhausted.")
        );

        if (attempt < retry.maxAttempts) {
          await sleep(delay);
        }
      }
    }

    throw new Error(
      `All ${retry.maxAttempts} send attempts failed. Last error: ${lastError?.message}`
    );
  }
}
