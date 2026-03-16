use anchor_lang::prelude::*;
use crate::errors::JobQueueError;

// ─────────────────────────────────────────────────────────────────────────────
// Queue Account
//
// Web2 equivalent: A named queue in Bull/Redis — e.g. "email-jobs", "resize-images"
// On Solana: A PDA account holding queue metadata and aggregate stats.
//            PDA seeds: [b"queue", authority.pubkey, queue_name.as_bytes]
//            This means every (authority, name) pair is a unique, deterministic address.
//
// Size: 8 (discriminator) + 32 + 36 + 8 + 8 + 8 + 8 + 1 + 1 + 8 + 1 + 32 = ~155 bytes
// ─────────────────────────────────────────────────────────────────────────────
#[account]
#[derive(Default)]
pub struct Queue {
    /// The wallet/program that created and controls this queue
    pub authority: Pubkey,        // 32

    /// Human-readable queue name (e.g. "email-notifications")
    pub name: String,             // 4 + 32

    /// Monotonically increasing counter — used as job PDA seed.
    /// Never decrements, so job PDAs are always derivable from (queue, id).
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
// QueueHead Account
//
// Web2 equivalent: The head/tail pointers of a doubly-linked list, plus a
//   total count — exactly the BookKeeper record in a message broker.
//
// On Solana: A PDA account that is the entry point for traversing the linked
//   list of JobIndex pages. Clients read this first to know which page to fetch.
//
// PDA seeds: [b"queue_head", queue_pubkey]
//
// Design rationale:
//   The flat Vec<u64> in a single JobIndex hits Solana's 10 MB account limit and
//   more practically the ~10 KB usable PDA size. By chaining fixed-size pages
//   (each holding MAX_INDEX_ENTRIES job IDs) and tracking head/tail sequence
//   numbers here, the index can grow to an unbounded number of pages while each
//   individual account stays small and within compute + serialisation limits.
//
//   head_index_seq  →  the oldest live page (workers dequeue from here)
//   tail_index_seq  →  the newest page (producers append here)
//   total_jobs      →  aggregate job count across ALL pages (for monitoring)
// ─────────────────────────────────────────────────────────────────────────────
#[account]
pub struct QueueHead {
    /// The queue this head belongs to (back-reference for safety checks)
    pub authority: Pubkey,        // 32

    /// Sequence number of the oldest (head) JobIndex page.
    /// Workers always read this page first.
    pub head_index_seq: u64,      // 8

    /// Sequence number of the newest (tail) JobIndex page.
    /// Producers append to this page; when it fills, a new page is allocated.
    pub tail_index_seq: u64,      // 8

    /// Total number of job IDs tracked across ALL pages in this linked list.
    /// Does not decrement when jobs are removed; use it for analytics only.
    pub total_jobs: u64,          // 8

    /// PDA bump seed
    pub bump: u8,                 // 1
}

impl QueueHead {
    // 8 disc + 32 authority + 8 head_seq + 8 tail_seq + 8 total_jobs + 1 bump + 32 padding
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 8 + 1 + 32;
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

    /// 0=low, 1=normal, 2=high
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

// ─────────────────────────────────────────────────────────────────────────────
// JobIndex Account — One "page" in the linked list
//
// Web2 equivalent: A single node in a doubly-linked list of message batches,
//   exactly how Kafka partitions work (fixed-size segments).
//
// On Solana: A PDA account holding up to MAX_INDEX_ENTRIES job IDs.
//   When this page is full, the producer allocates a new page (seq + 1) and
//   advances QueueHead.tail_index_seq.
//
// PDA seeds: [b"index", queue_pubkey, seq.to_le_bytes()]
//   — completely dynamic: no hard-coded status strings.
//   — every page is independently and deterministically addressable by (queue, seq).
//
// Page lifecycle:
//   seq=0  →  first page, created by initialize_queue alongside QueueHead
//   seq=N  →  subsequent pages, created by grow_index when the tail page fills
//
// Within a page, job_ids is an unordered Vec. Removal uses swap_remove (O(1)).
// The linked list advances (head_index_seq++) when the head page empties.
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum number of job IDs stored per JobIndex page.
/// Chosen to keep each page ≈ 2 KB and well within the per-account size budget.
/// 256 × 8 bytes = 2048 bytes of data + overhead.
pub const MAX_INDEX_ENTRIES: usize = 256;

#[account]
pub struct JobIndex {
    /// The queue this page belongs to (safety back-reference)
    pub queue: Pubkey,            // 32

    /// Sequence number of this page within the linked list.
    /// Also encodes into the PDA seed so every page has a unique address.
    pub seq: u64,                 // 8

    /// Next page's sequence number (0 means "no next page yet").
    /// Set when the producer creates a successor page via grow_index.
    pub next_seq: u64,            // 8

    /// Job IDs stored in this page. Unordered; removal is O(1) swap_remove.
    pub job_ids: Vec<u64>,        // 4 + MAX_INDEX_ENTRIES * 8

    /// PDA bump seed
    pub bump: u8,                 // 1
}

impl JobIndex {
    pub const SPACE: usize = 8            // discriminator
        + 32                              // queue
        + 8                               // seq
        + 8                               // next_seq
        + (4 + MAX_INDEX_ENTRIES * 8)     // job_ids vec
        + 1                               // bump
        + 32;                             // padding

    /// Returns true when this page has no room for more job IDs.
    #[inline]
    pub fn is_full(&self) -> bool {
        self.job_ids.len() >= MAX_INDEX_ENTRIES
    }

    /// Returns true when this page has no job IDs left.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.job_ids.is_empty()
    }

    /// Append a job ID. Errors with `IndexFull` if the page is at capacity.
    pub fn push_job(&mut self, job_id: u64) -> Result<()> {
        require!(!self.is_full(), JobQueueError::IndexFull);
        self.job_ids.push(job_id);
        Ok(())
    }

    /// Remove a job ID by value using O(1) swap_remove.
    /// Errors with `JobNotInIndex` if the job ID is not present.
    pub fn remove_job(&mut self, job_id: u64) -> Result<()> {
        let pos = self
            .job_ids
            .iter()
            .position(|&id| id == job_id)
            .ok_or(error!(JobQueueError::JobNotInIndex))?;
        self.job_ids.swap_remove(pos);
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZK Compression Integration
//
// ┌─── Web2 analogy ─────────────────────────────────────────────────────────┐
// │ Traditional DB row  →  stored in mutable on-chain account (rent-exempt)  │
// │ Replicated DB log   →  stored in Solana ledger, fingerprint on-chain     │
// └──────────────────────────────────────────────────────────────────────────┘
//
// What ZK Compression changes:
//   Standard Anchor #[account]:
//     - account data lives on-chain (each Job ≈ 900 bytes rent ≈ 0.007 SOL)
//     - trivially readable via getAccountInfo
//
//   Compressed account (light-sdk):
//     - account data is stored in the Solana LEDGER (not allocated on-chain)
//     - only a 32-byte Poseidon/Sha256 Merkle hash of all compressed accounts
//       is kept in an on-chain State Merkle Tree
//     - each Job ≈ 0 bytes on-chain rent → ~300× cheaper per job
//     - to read/write: supply a validity proof (ZK-SNARK) that the hash of
//       your data exists in the Merkle root — verified by the Light System Program
//
// Architecture:
//
//   ┌──── On-chain (rent-exempt) ─────────────────────────────────────────┐
//   │  Queue PDA          — metadata, job count                           │
//   │  QueueHead PDA      — linked-list pointers                          │
//   │  JobIndex PDAs      — arrays of job_ids (each ≈ 2 KB)              │
//   │  State Merkle Tree  — Merkle root of all compressed job hashes      │
//   └─────────────────────────────────────────────────────────────────────┘
//
//   ┌──── Ledger (free, permanent) ───────────────────────────────────────┐
//   │  JobAccount data    — full serialized struct in ledger history       │
//   │                       retrieved via indexer RPC, not getAccountInfo  │
//   └─────────────────────────────────────────────────────────────────────┘
//
// On-chain flow:
//   enqueue_job → LightSystemProgramCpi::new_cpi()
//                   .with_new_addresses(&[address_params])   // unique deterministic address
//                   .with_light_account(&mut compressed_job)? // sets hash in Merkle tree
//                   .invoke(cpi_accounts)?
//
//   claim_job   → LightSystemProgramCpi::new_cpi()
//                   .with_light_account(&mut compressed_job)? // reads old hash, writes new
//                   .invoke(cpi_accounts)?
//
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(feature = "zk-compression")]
use borsh::{BorshDeserialize, BorshSerialize};
#[cfg(feature = "zk-compression")]
use light_sdk::LightDiscriminator;

// ── Compressed job status as a primitive ─────────────────────────────────────
// We can't use the existing JobStatus enum directly inside a LightAccount data
// struct because Poseidon hashing requires all fields to map to field elements.
// We use a u8 instead — the same status values, different representation.
//
//   0 → Pending
//   1 → Processing
//   2 → Completed
//   3 → Failed
//   4 → Cancelled
#[cfg(feature = "zk-compression")]
pub const CJOB_PENDING:    u8 = 0;
#[cfg(feature = "zk-compression")]
pub const CJOB_PROCESSING: u8 = 1;
#[cfg(feature = "zk-compression")]
pub const CJOB_COMPLETED:  u8 = 2;
#[cfg(feature = "zk-compression")]
pub const CJOB_FAILED:     u8 = 3;
#[cfg(feature = "zk-compression")]
pub const CJOB_CANCELLED:  u8 = 4;

// ── JobAccount — the compressed account data struct ───────────────────────────
//
// This is NOT an Anchor #[account]. It has NO on-chain allocation.
// Its bytes are hashed (Sha256) and stored as a leaf in the State Merkle Tree.
//
// Rules for a valid LightAccount data struct (checked at compile time by
// LightDiscriminator):
//   - Clone + Debug + Default + BorshSerialize + BorshDeserialize
//   - All fields must be borsh-serializable (no Anchor-specific types like
//     Account<'info, T>, no raw pointers, no lifetimes)
//   - Pubkeys must use anchor_lang::prelude::Pubkey (which re-exports
//     solana_program::pubkey::Pubkey — the same type, just accessed differently)
//
// The LightDiscriminator derive macro generates a unique 8-byte discriminator
// for this type, preventing cross-type deserialization attacks.
//
// The LightHasher derive macro (Sha256 variant) generates the DataHasher impl
// that hashes the borsh-serialized struct body using Sha256.
// Sha256 is chosen over Poseidon here because:
//   - it is cheaper in compute units for multi-field structs
//   - we don't need ZK circuit compatibility (we're using compression for rent
//     savings, not for SNARK proofs over job data)
#[cfg(feature = "zk-compression")]
#[derive(
    Clone, Debug, Default,
    LightDiscriminator,
    BorshSerialize,
    BorshDeserialize,
)]
pub struct JobAccount {
    /// The queue this job belongs to.
    /// Stored as bytes to keep BorshSerialize impls simple.
    pub queue: [u8; 32],

    /// Monotonic job ID within the queue (also part of the compressed address).
    pub job_id: u64,

    /// Job type string, max 32 bytes, null-padded.
    pub job_type: [u8; 32],

    /// Serialized payload, max 512 bytes, length-prefixed via BorshSerialize.
    /// Only the first `payload_len` bytes are meaningful.
    pub payload_len: u16,
    pub payload: [u8; 512],

    /// Lifecycle state — use CJOB_* constants.
    pub status: u8,

    /// 0=low, 1=normal, 2=high
    pub priority: u8,

    /// Unix timestamp when the job was enqueued.
    pub created_at: i64,

    /// Earliest unix timestamp at which a worker may claim this job.
    pub execute_after: i64,

    /// Number of processing attempts so far.
    pub attempts: u8,

    /// Maximum attempts before permanent failure.
    pub max_retries: u8,

    /// The worker that currently holds / last processed this job.
    /// Zero pubkey = no worker.
    pub worker: [u8; 32],

    /// Unix timestamp when processing started for the last attempt.
    pub started_at: i64,

    /// Unix timestamp when the job reached a terminal state.
    pub completed_at: i64,
}

#[cfg(feature = "zk-compression")]
impl JobAccount {
    /// Convert from the queue's Pubkey to the [u8;32] representation.
    pub fn set_queue(&mut self, q: &Pubkey) {
        self.queue = q.to_bytes();
    }

    /// Extract the queue as a Pubkey.
    pub fn queue_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.queue)
    }

    /// Truncate a string into the fixed-width job_type field.
    pub fn set_job_type(&mut self, s: &str) {
        let bytes = s.as_bytes();
        let len = bytes.len().min(32);
        self.job_type[..len].copy_from_slice(&bytes[..len]);
    }

    /// Write payload bytes into the fixed-width payload field.
    pub fn set_payload(&mut self, data: &[u8]) {
        let len = data.len().min(512);
        self.payload[..len].copy_from_slice(&data[..len]);
        self.payload_len = len as u16;
    }
}

// ── CompressedJobMeta — instruction-data type ─────────────────────────────────
//
// Passed from the client to on-chain instructions that UPDATE an existing
// compressed JobAccount (claim_job, complete_job, fail_job, cancel_job).
//
// Light Protocol's instruction model:
//   - The client fetches the current CompressedAccountMeta from the indexer
//     (not from getAccountInfo — the account isn't on-chain)
//   - The client builds a ValidityProof proving the hash exists in the Merkle root
//   - Both are packed into instruction data and passed to the handler
//   - The handler calls LightSystemProgramCpi to verify the proof and update the leaf
//
// For CREATE (enqueue_job), instead of CompressedAccountMeta the client
// supplies PackedAddressTreeInfo + PackedStateTreeInfo — also from the indexer.
#[cfg(feature = "zk-compression")]
pub use light_sdk::instruction::account_meta::CompressedAccountMeta;
#[cfg(feature = "zk-compression")]
pub use light_sdk::instruction::{
    PackedAddressTreeInfo,
    PackedStateTreeInfo,
    ValidityProof,
};
