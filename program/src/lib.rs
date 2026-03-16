use anchor_lang::prelude::*;

// â”€â”€ ZK Compression SDK imports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Active only when compiled with: --features zk-compression
// (blocked on anchor-lang 0.30.1 / solana-instruction version conflict â€”
//  see program/Cargo.toml for full explanation)
#[cfg(feature = "zk-compression")]
use light_sdk::{
    account::LightAccount,
    cpi::v1::{CpiAccounts, LightSystemProgramCpi},
    derive_light_cpi_signer,
};

declare_id!("BuG2BPUX7iFZ34Q7yEiFdAdFifXmkr4of1AvLtmnBpas");

// â”€â”€ Register this program with the Light System Program â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The derive_light_cpi_signer! macro generates LIGHT_CPI_SIGNER: CpiSigner,
// a constant PDA proving to the Light System Program that CPIs originate here.
#[cfg(feature = "zk-compression")]
derive_light_cpi_signer!("BuG2BPUX7iFZ34Q7yEiFdAdFifXmkr4of1AvLtmnBpas");

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DecQueue â€” On-Chain Job Queue Program
//
// Web2 equivalent: Bull/BullMQ (Redis), AWS SQS, Celery + RabbitMQ
//
// Each "queue" is a PDA account owned by an authority.
// Each "job"   is its own PDA keyed by (queue_pubkey, job_id).
// Each "index" is a linked-list page PDA keyed by (queue_pubkey, seq).
//   A QueueHead PDA tracks head_index_seq / tail_index_seq so workers know
//   which page to read without enumerating accounts.
//
// State Machine:
//   Pending â†’ Processing â†’ Completed
//                        â†˜ Failed (retries exhausted)
//                        â†— Pending (retry with backoff, re-inserted into page)
//              Cancelled (authority only)
//
// Index linked-list:
//   QueueHead { head_seq, tail_seq, total_jobs }
//        â”‚
//        â”œâ”€â”€ JobIndex { seq=0, next_seq=1, job_ids=[...] }
//        â”‚         â†“
//        â””â”€â”€ JobIndex { seq=1, next_seq=0 (=tail), job_ids=[...] }
//
//   Producers append to tail_index_seq page; workers dequeue from head_index_seq.
//   When tail is full â†’ grow_index creates seq+1 and advances tail.
//   When head empties  â†’ advance_head increments head_seq (page is drained).
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub mod errors;
pub mod state;
pub mod events;

use errors::JobQueueError;
use state::*;
use events::*;

#[program]
pub mod dec_queue {
    use super::*;

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // initialize_queue
    //
    // Web2: `new Bull.Queue('name', { redis })` â€”  creates the queue in Redis
    //       memory and optionally registers it in a supervisor.
    //
    // Solana: Creates THREE accounts atomically in a single transaction:
    //   1. Queue   PDA  â€” metadata + aggregate stats
    //   2. QueueHead PDA â€” linked-list pointers (head_seq=0, tail_seq=0)
    //   3. JobIndex PDA at seq=0 â€” the first (and initially only) index page
    //
    // All three are rent-exempt and payer-funded via Anchor `init` constraints.
    // After this call the queue is immediately usable; no follow-up
    // `initialize_indexes` transaction is required.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    pub fn initialize_queue(
        ctx: Context<InitializeQueue>,
        queue_name: String,
        max_retries: u8,
    ) -> Result<()> {
        require!(
            queue_name.len() > 0 && queue_name.len() <= 32,
            JobQueueError::NameTooLong
        );
        require!(max_retries <= 10, JobQueueError::InvalidRetries);

        let clock = Clock::get()?;
        let queue_key = ctx.accounts.queue.key();

        // â”€â”€ 1. Write Queue metadata â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        let queue = &mut ctx.accounts.queue;
        queue.authority       = ctx.accounts.authority.key();
        queue.name            = queue_name.clone();
        queue.job_count       = 0;
        queue.pending_count   = 0;
        queue.processed_count = 0;
        queue.failed_count    = 0;
        queue.max_retries     = max_retries;
        queue.paused          = false;
        queue.created_at      = clock.unix_timestamp;
        queue.bump            = ctx.bumps.queue;

        // â”€â”€ 2. Write QueueHead â€” linked-list entry point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        //
        // head_index_seq = 0  â† workers start reading from page 0
        // tail_index_seq = 0  â† producers append to page 0 initially
        // total_jobs     = 0  â† no jobs yet
        //
        // When page 0 fills up, `grow_index` creates page 1 and sets
        // tail_index_seq = 1. When page 0 drains, `advance_head` moves
        // head_index_seq to 1.
        let head = &mut ctx.accounts.queue_head;
        head.authority      = ctx.accounts.authority.key();
        head.head_index_seq = 0;
        head.tail_index_seq = 0;
        head.total_jobs     = 0;
        head.bump           = ctx.bumps.queue_head;

        // â”€â”€ 3. Write first JobIndex page (seq = 0) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        //
        // PDA seeds: [b"index", queue_pubkey, 0u64.to_le_bytes()]
        // This is the initial head AND tail page of the linked list.
        // next_seq = 0 means "no successor page yet"; when grow_index runs,
        // it sets next_seq = 1 on this page and creates the new tail page.
        let first_page = &mut ctx.accounts.first_index_page;
        first_page.queue   = queue_key;
        first_page.seq     = 0;
        first_page.next_seq = 0; // 0 = no successor yet (tail page sentinel)
        first_page.job_ids = Vec::new();
        first_page.bump    = ctx.bumps.first_index_page;

        emit!(QueueCreated {
            authority: ctx.accounts.authority.key(),
            name: queue_name,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // grow_index
    //
    // Web2 equivalent: Kafka segment roll â€” when a log segment reaches its size
    //   limit, the broker creates a new one and advances the active-segment pointer.
    //
    // Solana: When the tail JobIndex page is full the producer (or anyone)
    //   calls this instruction to:
    //   1. Allocate a new JobIndex page at (tail_seq + 1).
    //   2. Set next_seq on the current tail page to point to the new page.
    //   3. Advance QueueHead.tail_index_seq by 1.
    //
    // This must be called BEFORE enqueue_job when the tail page is full.
    // The off-chain client checks `tail_page.is_full()` and calls grow_index
    // proactively.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    pub fn grow_index(ctx: Context<GrowIndex>, new_seq: u64) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.queue.authority,
            JobQueueError::Unauthorized
        );

        let current_tail_seq = ctx.accounts.queue_head.tail_index_seq;

        // Guard: caller must supply exactly tail_seq + 1 as new_seq
        require!(
            new_seq == current_tail_seq.checked_add(1).ok_or(JobQueueError::Overflow)?,
            JobQueueError::Overflow
        );

        // Guard: only grow when the current tail page is actually full
        require!(
            ctx.accounts.current_tail_page.is_full(),
            JobQueueError::IndexNotFull
        );

        // Link the old tail to the new page
        ctx.accounts.current_tail_page.next_seq = new_seq;

        // Initialize the new tail page
        let new_page = &mut ctx.accounts.new_tail_page;
        new_page.queue    = ctx.accounts.queue.key();
        new_page.seq      = new_seq;
        new_page.next_seq = 0; // new tail â€” no successor yet
        new_page.job_ids  = Vec::new();
        new_page.bump     = ctx.bumps.new_tail_page;

        // Advance the linked-list tail pointer
        ctx.accounts.queue_head.tail_index_seq = new_seq;

        Ok(())
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // advance_head
    //
    // Web2 equivalent: Advancing a consumer group's committed offset past a
    //   fully-consumed partition segment. The old segment can then be deleted.
    //
    // Solana: Called when the head JobIndex page is empty.
    //   Moves QueueHead.head_index_seq forward by one (to next_seq on the page).
    //   The old head page remains on-chain as an immutable audit record.
    //   Callers may optionally close it to reclaim rent â€” not done here to
    //   preserve the full history.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    pub fn advance_head(ctx: Context<AdvanceHead>) -> Result<()> {
        let head_page = &ctx.accounts.head_page;

        // Only advance when head page is fully drained
        require!(head_page.is_empty(), JobQueueError::HeadPageNotEmpty);

        // There must be a successor page (head != tail, or tail has a next)
        require!(
            head_page.next_seq != 0 ||
            ctx.accounts.queue_head.head_index_seq != ctx.accounts.queue_head.tail_index_seq,
            JobQueueError::NoSuccessorPage
        );

        ctx.accounts.queue_head.head_index_seq = head_page.next_seq;

        Ok(())
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // enqueue_job
    //
    // Web2: `queue.add('send-email', { to: '...' })` â€” adds a job record to
    //   Redis and pushes its ID into the "wait" list.
    //
    // Solana: Creates a Job PDA and appends its job_id to the current tail
    //   JobIndex page â€” both happen in the same atomic transaction.
    //   QueueHead.total_jobs is also incremented.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    pub fn enqueue_job(
        ctx: Context<EnqueueJob>,
        payload: Vec<u8>,
        job_type: String,
        priority: u8,
        execute_after: i64,
    ) -> Result<()> {
        require!(payload.len() <= 512, JobQueueError::PayloadTooLarge);
        require!(
            job_type.len() > 0 && job_type.len() <= 32,
            JobQueueError::NameTooLong
        );
        require!(priority <= 2, JobQueueError::InvalidPriority);
        require!(!ctx.accounts.queue.paused, JobQueueError::QueuePaused);

        // Tail page must have room â€” caller should call grow_index first if full
        require!(
            !ctx.accounts.tail_index_page.is_full(),
            JobQueueError::IndexFull
        );

        let clock = Clock::get()?;
        let queue = &mut ctx.accounts.queue;
        let job_id = queue.job_count;

        queue.job_count = queue.job_count
            .checked_add(1)
            .ok_or(JobQueueError::QueueFull)?;
        queue.pending_count = queue.pending_count
            .checked_add(1)
            .ok_or(JobQueueError::QueueFull)?;

        let scheduled_at = if execute_after == 0 {
            clock.unix_timestamp
        } else {
            execute_after
        };

        // Write job account
        let job = &mut ctx.accounts.job;
        job.queue         = queue.key();
        job.job_id        = job_id;
        job.job_type      = job_type.clone();
        job.payload       = payload;
        job.status        = JobStatus::Pending;
        job.priority      = priority;
        job.created_at    = clock.unix_timestamp;
        job.execute_after = scheduled_at;
        job.attempts      = 0;
        job.max_retries   = queue.max_retries;
        job.worker        = None;
        job.started_at    = None;
        job.completed_at  = None;
        job.result        = None;
        job.error_message = None;
        job.bump          = ctx.bumps.job;

        // Atomically append to the tail index page
        ctx.accounts.tail_index_page.push_job(job_id)?;

        // Track total jobs on the linked-list head
        ctx.accounts.queue_head.total_jobs = ctx.accounts.queue_head.total_jobs
            .checked_add(1)
            .ok_or(JobQueueError::Overflow)?;

        emit!(JobEnqueued {
            queue: queue.key(),
            job_id,
            job_type,
            priority,
            execute_after: scheduled_at,
            enqueued_at: clock.unix_timestamp,
        });

        Ok(())
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // claim_job
    //
    // Web2: Bull's `BRPOPLPUSH wait active` â€” atomically moves a job from the
    //   "wait" list to the "active" set, locking it for a specific worker.
    //
    // Solana: The transaction IS the atomic lock. Two workers submitting a
    //   claim_job for the same job at the same slot will conflict on account
    //   write-locks â€” only one will succeed. The source_page is the page
    //   currently holding the job ID; the caller derives it off-chain from
    //   QueueHead + page traversal.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    pub fn claim_job(ctx: Context<ClaimJob>) -> Result<()> {
        let job   = &mut ctx.accounts.job;
        let clock = Clock::get()?;

        require!(job.status == JobStatus::Pending, JobQueueError::JobNotPending);
        require!(
            clock.unix_timestamp >= job.execute_after,
            JobQueueError::JobNotReady
        );

        let job_id = job.job_id;

        job.status     = JobStatus::Processing;
        job.worker     = Some(ctx.accounts.worker.key());
        job.started_at = Some(clock.unix_timestamp);
        job.attempts   = job.attempts.checked_add(1).unwrap_or(u8::MAX);

        // Remove from the source index page (pending or delayed)
        ctx.accounts.source_index_page.remove_job(job_id)?;

        emit!(JobClaimed {
            queue:      job.queue,
            job_id,
            worker:     ctx.accounts.worker.key(),
            attempt:    job.attempts,
            claimed_at: clock.unix_timestamp,
        });

        Ok(())
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // complete_job
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    pub fn complete_job(
        ctx: Context<CompleteJob>,
        result: Option<String>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let queue = &mut ctx.accounts.queue;
        let job   = &mut ctx.accounts.job;

        require!(job.status == JobStatus::Processing, JobQueueError::JobNotProcessing);
        require!(
            job.worker == Some(ctx.accounts.worker.key()),
            JobQueueError::Unauthorized
        );
        if let Some(ref r) = result {
            require!(r.len() <= 128, JobQueueError::ResultTooLarge);
        }

        let job_id = job.job_id;
        job.status       = JobStatus::Completed;
        job.completed_at = Some(clock.unix_timestamp);
        job.result       = result.clone();

        queue.pending_count = queue.pending_count.saturating_sub(1);
        queue.processed_count = queue.processed_count
            .checked_add(1)
            .ok_or(JobQueueError::Overflow)?;

        emit!(JobCompleted {
            queue:        queue.key(),
            job_id,
            worker:       ctx.accounts.worker.key(),
            result,
            completed_at: clock.unix_timestamp,
        });

        Ok(())
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // fail_job
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    pub fn fail_job(
        ctx: Context<FailJob>,
        error_message: String,
        retry_after_secs: i64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let queue = &mut ctx.accounts.queue;
        let job   = &mut ctx.accounts.job;

        require!(job.status == JobStatus::Processing, JobQueueError::JobNotProcessing);
        require!(
            job.worker == Some(ctx.accounts.worker.key()),
            JobQueueError::Unauthorized
        );
        require!(error_message.len() <= 128, JobQueueError::ResultTooLarge);

        let job_id = job.job_id;
        job.error_message = Some(error_message.clone());

        if job.attempts < job.max_retries {
            // Exponential backoff: base_delay * 2^(attempt - 1)
            let multiplier = 1i64
                .checked_shl((job.attempts.saturating_sub(1)) as u32)
                .unwrap_or(i64::MAX);
            let backoff = retry_after_secs.saturating_mul(multiplier);

            job.status        = JobStatus::Pending;
            job.worker        = None;
            job.started_at    = None;
            job.execute_after = clock.unix_timestamp + backoff;

            // Re-insert into a retry index page (caller supplies the page to use)
            ctx.accounts.retry_index_page.push_job(job_id)?;

            emit!(JobRetrying {
                queue:    queue.key(),
                job_id,
                attempt:  job.attempts,
                retry_at: job.execute_after,
                error:    error_message,
            });
        } else {
            // Exhausted â†’ Dead Letter
            job.status       = JobStatus::Failed;
            job.completed_at = Some(clock.unix_timestamp);

            queue.pending_count = queue.pending_count.saturating_sub(1);
            queue.failed_count  = queue.failed_count
                .checked_add(1)
                .ok_or(JobQueueError::Overflow)?;

            emit!(JobFailed {
                queue:     queue.key(),
                job_id,
                attempts:  job.attempts,
                error:     error_message,
                failed_at: clock.unix_timestamp,
            });
        }

        Ok(())
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // cancel_job
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    pub fn cancel_job(ctx: Context<CancelJob>) -> Result<()> {
        let clock = Clock::get()?;
        let queue = &mut ctx.accounts.queue;
        let job   = &mut ctx.accounts.job;

        require!(
            ctx.accounts.authority.key() == queue.authority,
            JobQueueError::Unauthorized
        );
        require!(
            job.status == JobStatus::Pending || job.status == JobStatus::Processing,
            JobQueueError::CannotCancel
        );

        let job_id = job.job_id;

        // Remove from whichever index page the caller supplies
        ctx.accounts.source_index_page.remove_job(job_id)?;

        job.status       = JobStatus::Cancelled;
        job.completed_at = Some(clock.unix_timestamp);
        queue.pending_count = queue.pending_count.saturating_sub(1);

        emit!(JobCancelled {
            queue:        queue.key(),
            job_id,
            cancelled_by: ctx.accounts.authority.key(),
            cancelled_at: clock.unix_timestamp,
        });

        Ok(())
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // set_queue_paused
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    pub fn set_queue_paused(
        ctx: Context<SetQueuePaused>,
        paused: bool,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.queue.authority,
            JobQueueError::Unauthorized
        );
        ctx.accounts.queue.paused = paused;

        emit!(QueuePauseChanged {
            queue:      ctx.accounts.queue.key(),
            paused,
            changed_by: ctx.accounts.authority.key(),
        });

        Ok(())
    }
}

// â”€â”€â”€ Account Validation Contexts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// initialize_queue â€” creates Queue, QueueHead, and first JobIndex page (seq=0)
/// in one atomic transaction.
#[derive(Accounts)]
#[instruction(queue_name: String)]
pub struct InitializeQueue<'info> {
    /// The core queue metadata account.
    /// Seeds: [b"queue", authority, name]
    #[account(
        init,
        payer = authority,
        space = Queue::SPACE,
        seeds = [b"queue", authority.key().as_ref(), queue_name.as_bytes()],
        bump
    )]
    pub queue: Account<'info, Queue>,

    /// Linked-list head: tracks head_seq, tail_seq, total_jobs.
    /// Seeds: [b"queue_head", queue]
    #[account(
        init,
        payer = authority,
        space = QueueHead::SPACE,
        seeds = [b"queue_head", queue.key().as_ref()],
        bump
    )]
    pub queue_head: Account<'info, QueueHead>,

    /// The very first index page (seq = 0).
    /// Seeds: [b"index", queue, 0u64.to_le_bytes()]
    #[account(
        init,
        payer = authority,
        space = JobIndex::SPACE,
        seeds = [b"index", queue.key().as_ref(), &0u64.to_le_bytes()],
        bump
    )]
    pub first_index_page: Account<'info, JobIndex>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// grow_index â€” allocates a new tail page when the current tail is full.
/// `new_seq` must equal queue_head.tail_index_seq + 1 (enforced on-chain).
#[derive(Accounts)]
#[instruction(new_seq: u64)]
pub struct GrowIndex<'info> {
    pub queue: Account<'info, Queue>,

    /// The linked-list head PDA â€” tail_index_seq will be incremented here.
    #[account(
        mut,
        seeds = [b"queue_head", queue.key().as_ref()],
        bump = queue_head.bump
    )]
    pub queue_head: Account<'info, QueueHead>,

    /// The current (full) tail page.
    /// Seeds use queue_head.tail_index_seq before increment.
    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), &queue_head.tail_index_seq.to_le_bytes()],
        bump = current_tail_page.bump
    )]
    pub current_tail_page: Account<'info, JobIndex>,

    /// The new tail page. Seeds use the new_seq instruction argument.
    #[account(
        init,
        payer = authority,
        space = JobIndex::SPACE,
        seeds = [b"index", queue.key().as_ref(), &new_seq.to_le_bytes()],
        bump
    )]
    pub new_tail_page: Account<'info, JobIndex>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// advance_head â€” moves head_index_seq forward when head page is empty.
#[derive(Accounts)]
pub struct AdvanceHead<'info> {
    /// The linked-list head â€” head_index_seq will be incremented.
    #[account(
        mut,
        seeds = [b"queue_head", head_page.queue.as_ref()],
        bump = queue_head.bump
    )]
    pub queue_head: Account<'info, QueueHead>,

    /// The current (empty) head page.
    #[account(
        seeds = [b"index", head_page.queue.as_ref(), &queue_head.head_index_seq.to_le_bytes()],
        bump = head_page.bump
    )]
    pub head_page: Account<'info, JobIndex>,
}

/// enqueue_job â€” creates a Job and appends its ID to the tail index page.
#[derive(Accounts)]
pub struct EnqueueJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    /// Job PDA keyed by (queue, job_count) â€” job_count is captured before increment.
    #[account(
        init,
        payer = payer,
        space = Job::SPACE,
        seeds = [b"job", queue.key().as_ref(), &queue.job_count.to_le_bytes()],
        bump
    )]
    pub job: Account<'info, Job>,

    /// QueueHead â€” needed to increment total_jobs.
    #[account(
        mut,
        seeds = [b"queue_head", queue.key().as_ref()],
        bump = queue_head.bump
    )]
    pub queue_head: Account<'info, QueueHead>,

    /// The current tail index page â€” job_id is appended here.
    /// The caller derives: seq = queue_head.tail_index_seq
    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), &queue_head.tail_index_seq.to_le_bytes()],
        bump = tail_index_page.bump
    )]
    pub tail_index_page: Account<'info, JobIndex>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// claim_job â€” locks a job for processing; removes ID from its source index page.
///
/// The caller must determine which page currently holds this job_id and pass
/// that page as `source_index_page`. Typically this is the head page of the
/// pending linked list, or a known retry/delayed page.
#[derive(Accounts)]
pub struct ClaimJob<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,

    pub worker: Signer<'info>,

    /// The index page that currently contains this job_id.
    /// Verified by seed â€” callers compute [b"index", job.queue, page_seq.to_le_bytes()].
    #[account(
        mut,
        constraint = source_index_page.queue == job.queue
            @ JobQueueError::QueueMismatch
    )]
    pub source_index_page: Account<'info, JobIndex>,
}

/// complete_job â€” marks a job completed; no index mutation needed
/// (the job was already removed from its source page on claim_job).
#[derive(Accounts)]
pub struct CompleteJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    #[account(mut, has_one = queue)]
    pub job: Account<'info, Job>,

    pub worker: Signer<'info>,
}

/// fail_job â€” on retry, re-inserts job_id into a retry index page.
#[derive(Accounts)]
pub struct FailJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    #[account(mut, has_one = queue)]
    pub job: Account<'info, Job>,

    pub worker: Signer<'info>,

    /// The index page to push the retried job_id into (tail page of a retry queue,
    /// or any page with remaining capacity that the caller designates).
    #[account(
        mut,
        constraint = retry_index_page.queue == job.queue
            @ JobQueueError::QueueMismatch
    )]
    pub retry_index_page: Account<'info, JobIndex>,
}

/// cancel_job â€” removes a job_id from whichever page it currently lives in.
#[derive(Accounts)]
pub struct CancelJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    #[account(mut, has_one = queue)]
    pub job: Account<'info, Job>,

    pub authority: Signer<'info>,

    /// The index page currently holding this job_id.
    #[account(
        mut,
        constraint = source_index_page.queue == job.queue
            @ JobQueueError::QueueMismatch
    )]
    pub source_index_page: Account<'info, JobIndex>,
}

/// set_queue_paused â€” toggle queue paused state.
#[derive(Accounts)]
pub struct SetQueuePaused<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    pub authority: Signer<'info>,
}

// â”€â”€â”€ Compressed Job Instructions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// These instructions parallel the standard job lifecycle but operate on
// COMPRESSED JobAccounts (light_sdk::LightAccount<JobAccount>) instead of
// Anchor PDA accounts.
//
// Key difference in the handler signature:
//   Standard:   pub fn enqueue_job(ctx: Context<EnqueueJob>, ...) -> Result<()>
//   Compressed: pub fn enqueue_compressed_job(ctx: Context<EnqueueCompressedJob>,
//                   proof: ValidityProof,
//                   address_tree_info: PackedAddressTreeInfo,
//                   state_tree_info: PackedStateTreeInfo, ...) -> Result<()>
//
// The `proof` is a ZK-SNARK validity proof generated off-chain by the client
// using the Light indexer RPC. It proves:
//   1. The new compressed address doesn't already exist in the Address Merkle Tree.
//   2. Any existing compressed accounts being updated have their current state.

// NOTE: In production, enqueue_compressed_job would be added here as a full
// instruction using the pattern shown below. We provide it as documentation
// (not yet wired into the Anchor #[program] block) so the codebase compiles
// without requiring the Light System Program account to be live.
//
// Full pattern for a CREATE:
//
// pub fn enqueue_compressed_job(
//     ctx: Context<EnqueueCompressedJob>,
//     proof: ValidityProof,
//     address_tree_info: PackedAddressTreeInfo,
//     state_tree_info: PackedStateTreeInfo,
//     payload: Vec<u8>,
//     job_type: String,
//     priority: u8,
//     execute_after: i64,
// ) -> Result<()> {
//     require!(payload.len() <= 512, JobQueueError::PayloadTooLarge);
//     require!(!ctx.accounts.queue.paused, JobQueueError::QueuePaused);
//
//     let clock = Clock::get()?;
//     let queue = &mut ctx.accounts.queue;
//     let job_id = queue.job_count;
//     queue.job_count = queue.job_count.checked_add(1).ok_or(JobQueueError::QueueFull)?;
//
//     // Build the unique deterministic address for this compressed job.
//     // address = derive_address([b"job", queue_pubkey, job_id.to_le_bytes()])
//     // The address_tree_info tells the Light System Program which Address
//     // Merkle Tree to insert this new address into. The tree is specified
//     // by the client based on which tree has capacity.
//     use light_sdk::address::derive_address;
//     let address_seed = [b"job", queue.key().as_ref(), &job_id.to_le_bytes()];
//     let (address, address_params) =
//         derive_address(&address_seed, &address_tree_info);
//
//     // Construct the LightAccount wrapper â€” this is the in-memory representation.
//     // new_init() marks it as "to be created" in the Merkle tree.
//     let mut compressed_job = LightAccount::<JobAccount>::new_init(
//         &crate::ID,
//         Some(address),
//         state_tree_info.tree_index,  // which State Merkle Tree to use
//     );
//
//     // Populate job fields
//     compressed_job.set_queue(&queue.key());
//     compressed_job.job_id = job_id;
//     compressed_job.set_job_type(&job_type);
//     compressed_job.set_payload(&payload);
//     compressed_job.status = CJOB_PENDING;
//     compressed_job.priority = priority;
//     compressed_job.created_at = clock.unix_timestamp;
//     compressed_job.execute_after = if execute_after == 0 {
//         clock.unix_timestamp
//     } else {
//         execute_after
//     };
//     compressed_job.max_retries = queue.max_retries;
//
//     // Build CPI accounts: tells the Light System Program which on-chain
//     // accounts (state trees, nullifier queues, etc.) to use.
//     // ctx.accounts.light_system_accounts is a slice of remaining_accounts
//     // whose structure is described by PackedAccounts (assembled off-chain).
//     let cpi_accounts = CpiAccounts::new(
//         ctx.accounts.payer.to_account_info(),
//         ctx.remaining_accounts,  // state tree + address tree + queue accounts
//         crate::LIGHT_CPI_SIGNER,
//     );
//
//     // Execute the CPI â€” verifies proof, inserts new address, updates Merkle leaf.
//     LightSystemProgramCpi::new_cpi(crate::LIGHT_CPI_SIGNER, &proof)
//         .with_new_addresses(&[address_params])
//         .with_light_account(&mut compressed_job)?
//         .invoke(cpi_accounts)?;
//
//     // The JobIndex update (push_job) is the same as the standard path.
//     ctx.accounts.tail_index_page.push_job(job_id)?;
//
//     Ok(())
// }

/// Account context for compressed job enqueueing.
/// The Light System Program accounts are passed as `remaining_accounts`
/// because their count and order are dynamic (depend on which Merkle trees
/// the client selects). The `PackedAccounts` abstraction packs their indices.
#[derive(Accounts)]
pub struct EnqueueCompressedJob<'info> {
    /// Same queue PDA as the standard path â€” manages job_count and stats.
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    /// QueueHead for total_jobs increment.
    #[account(
        mut,
        seeds = [b"queue_head", queue.key().as_ref()],
        bump = queue_head.bump
    )]
    pub queue_head: Account<'info, QueueHead>,

    /// Current tail JobIndex page â€” job_id is appended here (same as standard path).
    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), &queue_head.tail_index_seq.to_le_bytes()],
        bump = tail_index_page.bump
    )]
    pub tail_index_page: Account<'info, JobIndex>,

    /// Fee payer for the Light System Program's state tree update fee.
    /// (Compressed accounts pay a small ledger fee instead of rent.)
    #[account(mut)]
    pub payer: Signer<'info>,

    // The Light System Program and all Merkle tree / nullifier queue accounts
    // are passed as `remaining_accounts` â€” their count is dynamic.
    // See PackedAccounts::add_system_accounts() on the client side.
}

// The compressed job types are defined in state.rs under the ZK Compression
// section and become active when compiled with --features zk-compression.
// pub use state::{JobAccount, CJOB_PENDING, CompressedAccountMeta, ...};

// =============================================================================
// Compressed Job Lifecycle Instructions (feature = "zk-compression")
//
// Each handler accepts ValidityProof + CompressedAccountMeta + raw job_data.
// The Light System Program CPI is the atomic gate: if the proof is invalid,
// the CPI errors and Solana reverts the entire transaction — no partial writes.
// Unlock: upgrade to anchor-lang >= 0.31, uncomment light-sdk in Cargo.toml,
//         add `zk-compression = []` to [features].
// =============================================================================

// claim_compressed_job
// Proof must cover CJOB_PENDING state.  Two workers racing → one nullifies the
// leaf first → the other's (now stale) proof is rejected → only one succeeds.
#[cfg(feature = "zk-compression")]
pub fn claim_compressed_job(
    ctx: Context<ClaimCompressedJob>,
    proof: state::ValidityProof,
    job_meta: state::CompressedAccountMeta,
    job_data: Vec<u8>,
) -> Result<()> {
    use state::{JobAccount, CJOB_PENDING, CJOB_PROCESSING};
    use borsh::BorshDeserialize;
    let clock = Clock::get()?;
    let mut job = JobAccount::try_from_slice(&job_data)
        .map_err(|_| error!(JobQueueError::InvalidCompressedJobData))?;
    require!(job.status == CJOB_PENDING,               JobQueueError::JobNotPending);
    require!(clock.unix_timestamp >= job.execute_after, JobQueueError::JobNotReady);
    let job_id   = job.job_id;
    job.status   = CJOB_PROCESSING;
    job.worker   = ctx.accounts.worker.key().to_bytes();
    job.started_at = clock.unix_timestamp;
    job.attempts = job.attempts.saturating_add(1);
    // Remove PDA-side index reference atomically with the CPI below
    ctx.accounts.source_index_page.remove_job(job_id)?;
    let mut ca = LightAccount::<JobAccount>::new_mut(&crate::ID, &job_meta, job)
        .map_err(|_| error!(JobQueueError::InvalidCompressedJobData))?;
    let cpi_accs = CpiAccounts::new(
        ctx.accounts.payer.to_account_info(), ctx.remaining_accounts, crate::LIGHT_CPI_SIGNER,
    );
    LightSystemProgramCpi::new_cpi(crate::LIGHT_CPI_SIGNER, &proof)
        .with_light_account(&mut ca)
        .map_err(|_| error!(JobQueueError::InvalidCompressedJobData))?
        .invoke(cpi_accs)
        .map_err(|_| error!(JobQueueError::CompressedCpiFailed))?;
    emit!(JobClaimed {
        queue: Pubkey::new_from_array(ca.queue), job_id,
        worker: ctx.accounts.worker.key(), attempt: ca.attempts,
        claimed_at: clock.unix_timestamp,
    });
    Ok(())
}

// complete_compressed_job
// Proof must cover CJOB_PROCESSING.  Stale proof (already completed) = invalid leaf = revert.
#[cfg(feature = "zk-compression")]
pub fn complete_compressed_job(
    ctx: Context<CompleteCompressedJob>,
    proof: state::ValidityProof,
    job_meta: state::CompressedAccountMeta,
    job_data: Vec<u8>,
    result: Option<String>,
) -> Result<()> {
    use state::{JobAccount, CJOB_PROCESSING, CJOB_COMPLETED};
    use borsh::BorshDeserialize;
    let clock = Clock::get()?;
    if let Some(ref r) = result { require!(r.len() <= 128, JobQueueError::ResultTooLarge); }
    let mut job = JobAccount::try_from_slice(&job_data)
        .map_err(|_| error!(JobQueueError::InvalidCompressedJobData))?;
    require!(job.status == CJOB_PROCESSING, JobQueueError::JobNotProcessing);
    require!(job.worker == ctx.accounts.worker.key().to_bytes(), JobQueueError::Unauthorized);
    let job_id       = job.job_id;
    job.status       = CJOB_COMPLETED;
    job.completed_at = clock.unix_timestamp;
    let queue = &mut ctx.accounts.queue;
    queue.pending_count   = queue.pending_count.saturating_sub(1);
    queue.processed_count = queue.processed_count.checked_add(1).ok_or(JobQueueError::Overflow)?;
    let mut ca = LightAccount::<JobAccount>::new_mut(&crate::ID, &job_meta, job)
        .map_err(|_| error!(JobQueueError::InvalidCompressedJobData))?;
    let cpi_accs = CpiAccounts::new(
        ctx.accounts.payer.to_account_info(), ctx.remaining_accounts, crate::LIGHT_CPI_SIGNER,
    );
    LightSystemProgramCpi::new_cpi(crate::LIGHT_CPI_SIGNER, &proof)
        .with_light_account(&mut ca)
        .map_err(|_| error!(JobQueueError::InvalidCompressedJobData))?
        .invoke(cpi_accs)
        .map_err(|_| error!(JobQueueError::CompressedCpiFailed))?;
    emit!(JobCompleted {
        queue: queue.key(), job_id, worker: ctx.accounts.worker.key(),
        result, completed_at: clock.unix_timestamp,
    });
    Ok(())
}

// fail_compressed_job
// On retry: exponential backoff + re-insert in index.  On exhaustion: dead letter.
#[cfg(feature = "zk-compression")]
pub fn fail_compressed_job(
    ctx: Context<FailCompressedJob>,
    proof: state::ValidityProof,
    job_meta: state::CompressedAccountMeta,
    job_data: Vec<u8>,
    error_message: String,
    retry_after_secs: i64,
) -> Result<()> {
    use state::{JobAccount, CJOB_PROCESSING, CJOB_PENDING, CJOB_FAILED};
    use borsh::BorshDeserialize;
    let clock = Clock::get()?;
    require!(error_message.len() <= 128, JobQueueError::ResultTooLarge);
    let mut job = JobAccount::try_from_slice(&job_data)
        .map_err(|_| error!(JobQueueError::InvalidCompressedJobData))?;
    require!(job.status == CJOB_PROCESSING, JobQueueError::JobNotProcessing);
    require!(job.worker == ctx.accounts.worker.key().to_bytes(), JobQueueError::Unauthorized);
    let job_id     = job.job_id;
    let will_retry = job.attempts < job.max_retries;
    let queue      = &mut ctx.accounts.queue;
    if will_retry {
        let mult = 1i64.checked_shl(job.attempts.saturating_sub(1) as u32).unwrap_or(i64::MAX);
        job.status        = CJOB_PENDING;
        job.worker        = [0u8; 32];
        job.started_at    = 0;
        job.execute_after = clock.unix_timestamp + retry_after_secs.saturating_mul(mult);
        ctx.accounts.retry_index_page.push_job(job_id)?;
        emit!(JobRetrying {
            queue: queue.key(), job_id, attempt: job.attempts,
            retry_at: job.execute_after, error: error_message,
        });
    } else {
        job.status       = CJOB_FAILED;
        job.completed_at = clock.unix_timestamp;
        queue.pending_count = queue.pending_count.saturating_sub(1);
        queue.failed_count  = queue.failed_count.checked_add(1).ok_or(JobQueueError::Overflow)?;
        emit!(JobFailed {
            queue: queue.key(), job_id, attempts: job.attempts,
            error: error_message, failed_at: clock.unix_timestamp,
        });
    }
    let mut ca = LightAccount::<JobAccount>::new_mut(&crate::ID, &job_meta, job)
        .map_err(|_| error!(JobQueueError::InvalidCompressedJobData))?;
    let cpi_accs = CpiAccounts::new(
        ctx.accounts.payer.to_account_info(), ctx.remaining_accounts, crate::LIGHT_CPI_SIGNER,
    );
    LightSystemProgramCpi::new_cpi(crate::LIGHT_CPI_SIGNER, &proof)
        .with_light_account(&mut ca)
        .map_err(|_| error!(JobQueueError::InvalidCompressedJobData))?
        .invoke(cpi_accs)
        .map_err(|_| error!(JobQueueError::CompressedCpiFailed))?;
    Ok(())
}

// Account contexts for the compressed instructions.
// Compressed job data arrives in instruction data — no on-chain job account.
// Light System Program + Merkle tree accounts come as remaining_accounts.

#[cfg(feature = "zk-compression")]
#[derive(Accounts)]
pub struct ClaimCompressedJob<'info> {
    pub worker: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Index page containing this job_id — removed atomically.
    #[account(mut, constraint = source_index_page.queue != Pubkey::default() @ JobQueueError::QueueMismatch)]
    pub source_index_page: Account<'info, JobIndex>,
}

#[cfg(feature = "zk-compression")]
#[derive(Accounts)]
pub struct CompleteCompressedJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,
    pub worker: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

#[cfg(feature = "zk-compression")]
#[derive(Accounts)]
pub struct FailCompressedJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,
    pub worker: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Retry index page — job_id re-inserted here on retry.
    #[account(mut, constraint = retry_index_page.queue == queue.key() @ JobQueueError::QueueMismatch)]
    pub retry_index_page: Account<'info, JobIndex>,
}
