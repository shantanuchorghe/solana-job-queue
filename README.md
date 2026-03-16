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
- React dashboard: real read-only queue explorer backed by live RPC reads

## Core Features

- Queue initialization with authority-scoped PDAs
- Job enqueue with payload, priority, and delayed execution
- Worker claim / complete / fail flow
- Example worker poller for demo job handlers
- Exponential retry backoff
- Failed-job dead-letter state
- Queue-level pause protection
- Authority-only cancellation paths

## Repo Layout

```text
program/   Anchor program
tests/     TypeScript Anchor tests
client/    TypeScript SDK + CLI + worker
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

Verified locally on March 14, 2026:

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
npm run worker:devnet -- <QUEUE_PDA>
```

The worker watches for ready jobs, claims them, and completes or fails them using
simple built-in demo handlers. Use `SOLQUEUE_QUEUE`, `SOLQUEUE_POLL_MS`, and
`SOLQUEUE_RETRY_AFTER_SECS` to tune it.

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
scheduled jobs, queue pause behavior, and worker authorization.

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

The dashboard now reads real queue/job accounts from `devnet` or `localnet`.
Paste a queue PDA into the header form and it will:

- fetch queue metadata and derived job PDAs live from RPC
- show actual job payloads, results, and error messages
- subscribe to live events that arrive while the page is open

The dashboard is intentionally read-only for the MVP.
Create/enqueue jobs from the CLI and let the worker process them.

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

## Windows Build Note

Top-level Anchor scripts go through `scripts/run-anchor.js`.
On Windows, that wrapper:

- uses `.tools/anchor.exe` if present
- falls back to `anchor` from `PATH`
- sets a short `CARGO_TARGET_DIR` under the system temp directory to avoid long-path issues on mapped drives
- copies the built `.so` back into `target/deploy/`

## Honest Limitations

- The React app is read-only in this MVP; queue mutation stays in the CLI.
- The example worker handles demo job types locally; it is not a generalized production worker runtime.
- Local validator startup may fail on some Windows environments with OS error `1314`.
- Devnet deployment of the current program binary needs materially more than `0.5 SOL`; budget closer to `~3 SOL` to have room for deploy + queue/job creation.
- The review-friendly path for this repo is currently `build -> deploy:devnet -> client:devnet -> worker:devnet -> app`.
