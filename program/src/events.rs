use anchor_lang::prelude::*;

// ─────────────────────────────────────────────────────────────────────────────
// Events — On-Chain Log Emissions
//
// Web2: Bull emits EventEmitter events (job.on('completed', cb))
//       or you subscribe to Redis pub/sub channels
//
// Solana: emit!() writes structured data into the transaction log.
//         Frontend clients subscribe via `program.addEventListener(...)` — 
//         exactly like WebSocket subscriptions, but trustless and chain-indexed.
//         Explorers like Solscan also parse these for human-readable tx history.
// ─────────────────────────────────────────────────────────────────────────────

#[event]
pub struct QueueCreated {
    pub authority: Pubkey,
    pub name: String,
    pub timestamp: i64,
}

#[event]
pub struct QueuePauseChanged {
    pub queue: Pubkey,
    pub paused: bool,
    pub changed_by: Pubkey,
}

#[event]
pub struct JobEnqueued {
    pub queue: Pubkey,
    pub job_id: u64,
    pub job_type: String,
    pub priority: u8,
    pub execute_after: i64,
    pub enqueued_at: i64,
}

#[event]
pub struct JobClaimed {
    pub queue: Pubkey,
    pub job_id: u64,
    pub worker: Pubkey,
    pub attempt: u8,
    pub claimed_at: i64,
}

#[event]
pub struct JobCompleted {
    pub queue: Pubkey,
    pub job_id: u64,
    pub worker: Pubkey,
    pub result: Option<String>,
    pub completed_at: i64,
}

#[event]
pub struct JobRetrying {
    pub queue: Pubkey,
    pub job_id: u64,
    pub attempt: u8,
    pub retry_at: i64,
    pub error: String,
}

#[event]
pub struct JobFailed {
    pub queue: Pubkey,
    pub job_id: u64,
    pub attempts: u8,
    pub error: String,
    pub failed_at: i64,
}

#[event]
pub struct JobCancelled {
    pub queue: Pubkey,
    pub job_id: u64,
    pub cancelled_by: Pubkey,
    pub cancelled_at: i64,
}
