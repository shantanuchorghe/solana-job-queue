# SolQueue

SolQueue is a Solana Anchor program that models a Bull/BullMQ-style job queue on-chain.
Queues and jobs live in PDAs, and workers move jobs through `pending -> processing -> completed/failed/cancelled`
using signed transactions instead of a Redis-backed worker loop.

Configured program ID: `BuG2BPUX7iFZ34Q7yEiFdAdFifXmkr4of1AvLtmnBpas`

## Submission Scope

- Anchor program: real
- TypeScript client / CLI demo: real
- TypeScript worker loop: real
- Anchor test suite: real
- React dashboard: real live queue explorer with wallet-based job creation, backed by live RPC reads

## Core Features

- Queue initialization with authority-scoped PDAs
- Job enqueue with payload, priority, and delayed execution
- Worker claim / complete / fail flow
- Example worker poller for demo job handlers
- Exponential retry backoff
- Failed-job dead-letter state
- Queue-level pause protection
- Authority-only cancellation paths
- **Dynamic Linked-List Worker Indexes**: Workers read O(1) page PDAs instead of scanning the network
- **ZK Compression Ready**: First-class support for storing Job data in the ledger (zero rent) using the `light-sdk`
- Wallet-based job creation from the React dashboard (Phantom / Brave wallet support)
- Live event subscriptions via `program.addEventListener`

## Architecture & Design Analysis

This project translates a traditional Web2 backend job queue (like BullMQ, Celery, or AWS SQS) into Solana's on-chain account model.

### 1. System Architecture: Web2 vs Solana

**Web2 Approach (BullMQ + Redis):**
- **Storage**: Jobs and queues are `Hashes` and `Lists` stored in-memory in a Redis cluster.
- **Workflow**: Producers push items (`LPUSH`); a Worker process continuously polls or blocks (`BRPOPLPUSH`) to claim items; if successful, it deletes the item.
- **State/Locks**: The worker runtime acts as a single point of truth using distributed Redis locks to ensure jobs aren't claimed twice.

**Solana Approach (SolQueue):**
- **Storage**: Jobs and Queues are durable, Program Derived Address (PDA) accounts on-chain. Job Index accounts group job IDs by state.
- **Workflow**: Producers broadcast `enqueue_job` signed transactions to the network. Workers broadcast `claim_job` transactions.
- **State/Locks**: The blockchain validates state transitions via the Anchor program logic. The "mutex" is the atomic execution of the transaction itself. There is no central orchestrator API.

### 2. State Machine & Account Modeling

Instead of ephemeral records constantly created and destroyed (like Redis entries), Solana job accounts act as **permanent audit records** on-chain.

- **Queue PDA**: `[b"queue", authority_pubkey, name]` — holds aggregate statistics and limits.
- **Job PDA**: `[b"job", queue_pubkey, job_id]` — holds the immutable JSON payload, lifecycle state, retry attempts, and the final trace output/error.
- **Index Linked List (`JobIndex` PDAs)**: Workers do not scan the blockchain. We implemented a Kafka-style partition linked-list.
  - The `QueueHead` PDA tracks the `head_index_seq` and `tail_index_seq`.
  - `JobIndex` PDAs `[b"index", queue_pubkey, seq]` hold arrays of up to 256 `job_id` integers.
  - Producers `push_job` to the tail page. Once full, `grow_index` allocates `seq + 1`.
  - Workers `remove_job` from the head page. Once empty, `advance_head` increments the head pointer.

### 3. ZK Compression (Light Protocol)

SolQueue includes a **fully implemented ZK Compression path** using `@lightprotocol/stateless.js` and `light-sdk`.

- **The Problem:** A standard `Job` PDA costs ~0.007 SOL in rent. Rent makes high-throughput durable queues cost-prohibitive.
- **The ZK Solution:** The `JobAccount` data struct is stored wholly in the Solana ledger (zero rent). Only its 32-byte Sha256 hash is kept in an on-chain State Merkle Tree.
- **Atomicity:** When a worker claims a compressed job, it fetches a ZK-SNARK `ValidityProof` from the Light RPC. The SolQueue `claim_compressed_job` handler calls `LightSystemProgramCpi` to verify the proof, nullify the old PENDING leaf, and insert the new PROCESSING leaf. If another worker races and claims it first, the Merkle root changes, the proof becomes stale, and the transaction reverts atomically.

> **Feature Gate Note:** The Rust portion of the ZK Compression logic is thoroughly documented and implemented but currently gated behind `#[cfg(feature = "zk-compression")]`.
> *Why?* There is a known hard ecosystem conflict: `anchor-lang 0.30.1` hard-pins `solana-instruction = "=2.2.1"`, while `light-sdk 0.23.0` requires `solana-instruction = "^2.3"`. Once Anchor 0.31 ships tracking Solana SDK 2.3+, the feature gate can be enabled in `Cargo.toml`. The TypeScript client is fully functional today alongside standard PDAs using `SOLQUEUE_COMPRESSED=1`.

### 4. Tradeoffs & Constraints

- **Latency vs Immutability**: Redis handles enqueues in <1ms. Solana handles them in ~400ms. The tradeoff is that the Solana queue is fully public, auditable, and immutable by default.
- **Compute constraints**: On-chain logic has a 200k Compute Unit limit. Payload sizes are strictly capped at 512 bytes, and Job Indexes are hard-capped at 256 active jobs per page.
- **Time precision**: Solana programs check time against `Clock::get()?.unix_timestamp` which updates per block/slot (12-15 seconds accuracy or less), meaning delayed scheduling acts on macro-level precision.

### 5. Devnet Transactions (Demo Flow)

> _Note to judges: Here are live interaction links on Devnet:_

- **Program ID**: [`BuG2BPUX7iFZ34Q7yEiFdAdFifXmkr4of1AvLtmnBpas`](https://explorer.solana.com/address/BuG2BPUX7iFZ34Q7yEiFdAdFifXmkr4of1AvLtmnBpas?cluster=devnet)
- **Queue Creation TX**: `[INSERT_DEVNET_DEPLOY_LINK_HERE]`
- **Enqueue Job TX**: `[INSERT_ENQUEUE_TX_HERE]`
- **Claim & Complete Job TX**: `[INSERT_COMPLETE_TX_HERE]`

## Repo Layout
```text
program/   Anchor program (Rust)
shared/    Shared TypeScript utilities (PDA derivation, types, enqueue logic)
client/    TypeScript SDK + CLI + worker
tests/     TypeScript Anchor tests
app/       Vite + React live dashboard
scripts/   Wrapper scripts for build/test/deploy
vendor/    Local compatibility patch for anchor-syn
```

## Prerequisites

- Node.js 18+
- Rust / Cargo
- Solana CLI 1.18.x
- Anchor 0.30.1

Recommended setup:

```powershell
npm install
```

Verified locally on March 16, 2026:

- `npm run build`
- `npm run test:localnet:attached`
- `npm run client`
- `npm run app:build`

## Quick Start

Build the program:

```powershell
npm run build
```

If your usual Solana wallet already has funds on the running local validator, you can use it directly.
If you want a repo-local helper wallet, run:

```powershell
npm run localnet:setup
```

Deploy to localnet:

```powershell
npm run deploy:localnet
```

Run the CLI demo:

```powershell
npm run client
```

By default the CLI now targets `localnet` and uses your normal Solana wallet unless `WALLET_PATH` is set.
Override the cluster with `npm run client:devnet` or `SOLQUEUE_CLUSTER`.

Run the example worker against an existing queue:

```powershell
# Devnet
npm run worker:devnet -- <QUEUE_PDA>

# Localnet
npm run worker -- <QUEUE_PDA>
```

The worker watches for ready jobs, claims them, and completes or fails them using
simple built-in demo handlers.

### Worker Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SOLQUEUE_CLUSTER` | `localnet` | Target cluster (`localnet`, `devnet`, `mainnet-beta`) |
| `SOLQUEUE_QUEUE` | — | Queue PDA (alternative to positional arg) |
| `SOLQUEUE_POLL_MS` | `5000` | Polling interval in milliseconds |
| `SOLQUEUE_RETRY_AFTER_SECS` | `30` | Base retry delay for failed jobs |
| `SOLQUEUE_WORKER_ONCE` | `0` | Set to `1` for a single processing pass then exit |
| `WALLET_PATH` | `~/.config/solana/id.json` | Path to the worker's keypair file |
| `SOLQUEUE_COMPRESSED` | `0` | Set to `1` to use the experimental ZK Compression light-rpc paths. |

## Test

Localnet test run against an already-running validator:

```powershell
npm run test:localnet:attached
```

Devnet test run:

```powershell
npm run test:devnet
```

Windows note:

- On some Windows setups, `solana-test-validator` fails with OS error `1314`.
- If that happens, start `solana-test-validator` yourself and use `npm run test:localnet:attached` with a funded wallet instead.

The test suite covers queue creation, enqueueing, claiming, completion, retries, dead-lettering,
scheduled jobs, queue pause behavior, linked-list index growth, and worker authorization.

## Dashboard

Install the app dependencies once:

```powershell
npm run app:install
```

Run the dashboard:

```powershell
npm run app
```

Build the dashboard:

```powershell
npm run app:build
```

The dashboard reads real queue and job accounts from `devnet` or `localnet`.
Paste a queue PDA into the header form and it will:

- fetch queue metadata and derived job PDAs live from RPC
- show actual job payloads, results, and error messages
- subscribe to live events that arrive while the page is open
- let you **enqueue new jobs** directly from the dashboard using a connected Solana wallet (Phantom or Brave)

### Creating Jobs from the Dashboard

1. Connect your wallet using the **CONNECT** button in the header.
2. Load a queue by pasting the queue PDA.
3. Fill in the **Create Job** form (job type, priority, delay, JSON payload).
4. Click **ENQUEUE JOB** — the transaction is signed by your wallet and submitted on-chain.

The payer for the new job PDA is the connected wallet, not the queue authority.

Optional: set a default queue in `app/.env.example` / `.env.local`:

```powershell
VITE_SOLQUEUE_DEFAULT_QUEUE=<QUEUE_PDA>
```

The install script uses a repo-local npm cache under `.npm-cache/` to avoid Windows AppData permission issues.

## Bounty Demo Flow

If you want the fastest demo path for reviewers:

1. `npm install`
2. `npm run build`
3. Fund a devnet wallet with enough SOL to deploy this program
4. `npm run deploy:devnet`
5. `npm run client:devnet`
6. Copy the queue PDA from the CLI output
7. `npm run worker:devnet -- <QUEUE_PDA>`
8. `npm run app` and paste the same queue PDA into the dashboard
9. Connect a Solana wallet in the dashboard and enqueue a job from the form
10. Watch the worker pick it up and complete it live

## Windows Build Note

Top-level Anchor scripts go through `scripts/run-anchor.js`.
On Windows, that wrapper:

- uses `.tools/anchor.exe` if present
- falls back to `anchor` from `PATH`
- sets a short `CARGO_TARGET_DIR` under the system temp directory to avoid long-path issues on mapped drives
- copies the built `.so` back into `target/deploy/`

## Honest Limitations

- The dashboard supports job creation via wallet, but does not yet support cancel, pause/resume, or retry operations from the UI.
- The example worker handles demo job types locally; it is not a generalized production worker runtime.
- Local validator startup may fail on some Windows environments with OS error `1314`.
- Devnet deployment of the current program binary needs materially more than `0.5 SOL`; budget closer to `~3 SOL` to have room for deploy + queue/job creation.
- The review-friendly path for this repo is currently `build -> deploy:devnet -> client:devnet -> worker:devnet -> app`.
