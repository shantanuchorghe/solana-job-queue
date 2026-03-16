use anchor_lang::prelude::*;

// ─────────────────────────────────────────────────────────────────────────────
// Queue Account
//
// Web2 equivalent: A named queue in Bull/Redis — e.g. "email-jobs", "resize-images"
// On Solana: A PDA account holding queue metadata and aggregate stats.
//            PDA seeds: [b"queue", authority.pubkey, queue_name.as_bytes]
//            This means every (authority, name) pair is a unique, deterministic address.
//
// Size: 8 (discriminator) + 32 + 36 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 8 + 1 = ~120 bytes
// ─────────────────────────────────────────────────────────────────────────────
#[account]
#[derive(Default)]
pub struct Queue {
    /// The wallet/program that created and controls this queue
    pub authority: Pubkey,        // 32

    /// Human-readable queue name (e.g. "email-notifications")
    pub name: String,             // 4 + 32

    /// Monotonically increasing counter — used as job PDA seed
    /// Never decrements, so job PDAs are always derivable from (queue, id)
    pub job_count: u64,           // 8

    /// Live count of Pending + Processing jobs
    pub pending_count: u64,       // 8

    /// Total successfully completed jobs
    pub processed_count: u64,     // 8

    /// Total permanently failed jobs (dead letter count)
    pub failed_count: u64,        // 8

    /// Default max retry attempts for jobs created in this queue
    pub max_retries: u8,          // 1

    /// When true, new jobs cannot be enqueued
    pub paused: bool,             // 1

    /// Unix timestamp of queue creation
    pub created_at: i64,          // 8

    /// PDA bump seed
    pub bump: u8,                 // 1
}

impl Queue {
    // 8 discriminator + 32 authority + (4+32) name + 8 job_count
    // + 8 pending + 8 processed + 8 failed + 1 max_retries + 1 paused
    // + 8 created_at + 1 bump + 32 padding
    pub const SPACE: usize = 8 + 32 + 36 + 8 + 8 + 8 + 8 + 1 + 1 + 8 + 1 + 32;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job Account
//
// Web2 equivalent: A job record in Bull/Redis or a row in a jobs DB table
// On Solana: A PDA account storing the full job lifecycle.
//            PDA seeds: [b"job", queue.pubkey, job_id.to_le_bytes()]
//
// Key insight: In Web2, job data lives in Redis/DB and is deleted after completion.
// On Solana, job accounts are permanent, auditable records on-chain.
// This gives you a built-in job history log — no separate audit DB needed.
//
// Size breakdown:
//   8 disc + 32 queue + 8 job_id + (4+32) job_type + (4+512) payload
//   + 1 status + 1 priority + 8 created_at + 8 execute_after
//   + 1 attempts + 1 max_retries + (1+32) worker + (1+8) started_at
//   + (1+8) completed_at + (1+132) result + (1+132) error + 1 bump
// ─────────────────────────────────────────────────────────────────────────────
#[account]
pub struct Job {
    /// The queue this job belongs to
    pub queue: Pubkey,            // 32

    /// Monotonic ID within the queue (used as PDA seed)
    pub job_id: u64,              // 8

    /// Job type identifier — workers use this to route to handler functions
    /// e.g. "send-email", "resize-image", "send-webhook"
    pub job_type: String,         // 4 + 32

    /// Arbitrary serialized payload — typically JSON or borsh bytes
    /// Workers deserialize this to get job arguments
    pub payload: Vec<u8>,         // 4 + 512

    /// Current lifecycle state
    pub status: JobStatus,        // 1

    /// 0=low, 1=normal, 2=high — workers can fetch by priority off-chain
    pub priority: u8,             // 1

    /// When this job was enqueued
    pub created_at: i64,          // 8

    /// Earliest time this job can be claimed (enables delayed/scheduled jobs)
    pub execute_after: i64,       // 8

    /// Number of times this job has been attempted (incremented on claim)
    pub attempts: u8,             // 1

    /// Maximum attempts before permanent failure
    pub max_retries: u8,          // 1

    /// The worker that currently holds / last processed this job
    pub worker: Option<Pubkey>,   // 1 + 32

    /// When the current/last processing attempt began
    pub started_at: Option<i64>,  // 1 + 8

    /// When the job reached a terminal state (Completed/Failed/Cancelled)
    pub completed_at: Option<i64>, // 1 + 8

    /// Result data written by the worker on success
    pub result: Option<String>,   // 1 + 4 + 128

    /// Error message on failure
    pub error_message: Option<String>, // 1 + 4 + 128

    /// PDA bump seed
    pub bump: u8,                 // 1
}

impl Job {
    pub const SPACE: usize = 8    // discriminator
        + 32                      // queue
        + 8                       // job_id
        + (4 + 32)                // job_type string
        + (4 + 512)               // payload vec
        + 1                       // status enum
        + 1                       // priority
        + 8                       // created_at
        + 8                       // execute_after
        + 1                       // attempts
        + 1                       // max_retries
        + (1 + 32)                // worker Option<Pubkey>
        + (1 + 8)                 // started_at Option<i64>
        + (1 + 8)                 // completed_at Option<i64>
        + (1 + 4 + 128)           // result Option<String>
        + (1 + 4 + 128)           // error_message Option<String>
        + 1                       // bump
        + 64;                     // padding
}

// ─────────────────────────────────────────────────────────────────────────────
// JobStatus — The On-Chain State Machine
//
// Web2: Bull stores job state as a Redis key in named lists:
//         wait → active → completed
//                       ↘ failed → (retry) → wait
// Solana: Single enum field on the job account. Transitions are enforced
//         by require!() guards in each instruction — the program IS the state machine.
//         No external process can corrupt the state without a valid signed tx.
// ─────────────────────────────────────────────────────────────────────────────
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum JobStatus {
    /// Awaiting a worker to claim it (equivalent to Bull's "waiting" list)
    Pending,

    /// Locked by a specific worker (equivalent to Bull's "active" set)
    Processing,

    /// Successfully finished — result available on-chain
    Completed,

    /// Permanently failed after exhausting retries (Bull's "failed" set / dead letter)
    Failed,

    /// Removed by queue authority before completion
    Cancelled,
}

impl Default for JobStatus {
    fn default() -> Self {
        JobStatus::Pending
    }
}
