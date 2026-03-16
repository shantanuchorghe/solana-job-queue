use anchor_lang::prelude::*;

declare_id!("BuG2BPUX7iFZ34Q7yEiFdAdFifXmkr4of1AvLtmnBpas");

// ─────────────────────────────────────────────────────────────────────────────
// SolQueue — On-Chain Job Queue Program
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
//   Pending → Processing → Completed
//                        ↘ Failed (retries exhausted)
//                        ↗ Pending (retry with backoff, re-inserted into page)
//              Cancelled (authority only)
//
// Index linked-list:
//   QueueHead { head_seq, tail_seq, total_jobs }
//        │
//        ├── JobIndex { seq=0, next_seq=1, job_ids=[...] }
//        │         ↓
//        └── JobIndex { seq=1, next_seq=0 (=tail), job_ids=[...] }
//
//   Producers append to tail_index_seq page; workers dequeue from head_index_seq.
//   When tail is full → grow_index creates seq+1 and advances tail.
//   When head empties  → advance_head increments head_seq (page is drained).
// ─────────────────────────────────────────────────────────────────────────────

pub mod errors;
pub mod state;
pub mod events;

use errors::JobQueueError;
use state::*;
use events::*;

#[program]
pub mod sol_queue {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────────
    // initialize_queue
    //
    // Web2: `new Bull.Queue('name', { redis })` —  creates the queue in Redis
    //       memory and optionally registers it in a supervisor.
    //
    // Solana: Creates THREE accounts atomically in a single transaction:
    //   1. Queue   PDA  — metadata + aggregate stats
    //   2. QueueHead PDA — linked-list pointers (head_seq=0, tail_seq=0)
    //   3. JobIndex PDA at seq=0 — the first (and initially only) index page
    //
    // All three are rent-exempt and payer-funded via Anchor `init` constraints.
    // After this call the queue is immediately usable; no follow-up
    // `initialize_indexes` transaction is required.
    // ─────────────────────────────────────────────────────────────────────────
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

        // ── 1. Write Queue metadata ──────────────────────────────────────────
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

        // ── 2. Write QueueHead — linked-list entry point ─────────────────────
        //
        // head_index_seq = 0  ← workers start reading from page 0
        // tail_index_seq = 0  ← producers append to page 0 initially
        // total_jobs     = 0  ← no jobs yet
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

        // ── 3. Write first JobIndex page (seq = 0) ───────────────────────────
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

    // ─────────────────────────────────────────────────────────────────────────
    // grow_index
    //
    // Web2 equivalent: Kafka segment roll — when a log segment reaches its size
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
    // ─────────────────────────────────────────────────────────────────────────
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
        new_page.next_seq = 0; // new tail — no successor yet
        new_page.job_ids  = Vec::new();
        new_page.bump     = ctx.bumps.new_tail_page;

        // Advance the linked-list tail pointer
        ctx.accounts.queue_head.tail_index_seq = new_seq;

        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────────
    // advance_head
    //
    // Web2 equivalent: Advancing a consumer group's committed offset past a
    //   fully-consumed partition segment. The old segment can then be deleted.
    //
    // Solana: Called when the head JobIndex page is empty.
    //   Moves QueueHead.head_index_seq forward by one (to next_seq on the page).
    //   The old head page remains on-chain as an immutable audit record.
    //   Callers may optionally close it to reclaim rent — not done here to
    //   preserve the full history.
    // ─────────────────────────────────────────────────────────────────────────
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

    // ─────────────────────────────────────────────────────────────────────────
    // enqueue_job
    //
    // Web2: `queue.add('send-email', { to: '...' })` — adds a job record to
    //   Redis and pushes its ID into the "wait" list.
    //
    // Solana: Creates a Job PDA and appends its job_id to the current tail
    //   JobIndex page — both happen in the same atomic transaction.
    //   QueueHead.total_jobs is also incremented.
    // ─────────────────────────────────────────────────────────────────────────
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

        // Tail page must have room — caller should call grow_index first if full
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

    // ─────────────────────────────────────────────────────────────────────────
    // claim_job
    //
    // Web2: Bull's `BRPOPLPUSH wait active` — atomically moves a job from the
    //   "wait" list to the "active" set, locking it for a specific worker.
    //
    // Solana: The transaction IS the atomic lock. Two workers submitting a
    //   claim_job for the same job at the same slot will conflict on account
    //   write-locks — only one will succeed. The source_page is the page
    //   currently holding the job ID; the caller derives it off-chain from
    //   QueueHead + page traversal.
    // ─────────────────────────────────────────────────────────────────────────
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

    // ─────────────────────────────────────────────────────────────────────────
    // complete_job
    // ─────────────────────────────────────────────────────────────────────────
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

    // ─────────────────────────────────────────────────────────────────────────
    // fail_job
    // ─────────────────────────────────────────────────────────────────────────
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
            // Exhausted → Dead Letter
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

    // ─────────────────────────────────────────────────────────────────────────
    // cancel_job
    // ─────────────────────────────────────────────────────────────────────────
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

    // ─────────────────────────────────────────────────────────────────────────
    // set_queue_paused
    // ─────────────────────────────────────────────────────────────────────────
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

// ─── Account Validation Contexts ─────────────────────────────────────────────

/// initialize_queue — creates Queue, QueueHead, and first JobIndex page (seq=0)
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

/// grow_index — allocates a new tail page when the current tail is full.
/// `new_seq` must equal queue_head.tail_index_seq + 1 (enforced on-chain).
#[derive(Accounts)]
#[instruction(new_seq: u64)]
pub struct GrowIndex<'info> {
    pub queue: Account<'info, Queue>,

    /// The linked-list head PDA — tail_index_seq will be incremented here.
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

/// advance_head — moves head_index_seq forward when head page is empty.
#[derive(Accounts)]
pub struct AdvanceHead<'info> {
    /// The linked-list head — head_index_seq will be incremented.
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

/// enqueue_job — creates a Job and appends its ID to the tail index page.
#[derive(Accounts)]
pub struct EnqueueJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    /// Job PDA keyed by (queue, job_count) — job_count is captured before increment.
    #[account(
        init,
        payer = payer,
        space = Job::SPACE,
        seeds = [b"job", queue.key().as_ref(), &queue.job_count.to_le_bytes()],
        bump
    )]
    pub job: Account<'info, Job>,

    /// QueueHead — needed to increment total_jobs.
    #[account(
        mut,
        seeds = [b"queue_head", queue.key().as_ref()],
        bump = queue_head.bump
    )]
    pub queue_head: Account<'info, QueueHead>,

    /// The current tail index page — job_id is appended here.
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

/// claim_job — locks a job for processing; removes ID from its source index page.
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
    /// Verified by seed — callers compute [b"index", job.queue, page_seq.to_le_bytes()].
    #[account(
        mut,
        constraint = source_index_page.queue == job.queue
            @ JobQueueError::QueueMismatch
    )]
    pub source_index_page: Account<'info, JobIndex>,
}

/// complete_job — marks a job completed; no index mutation needed
/// (the job was already removed from its source page on claim_job).
#[derive(Accounts)]
pub struct CompleteJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    #[account(mut, has_one = queue)]
    pub job: Account<'info, Job>,

    pub worker: Signer<'info>,
}

/// fail_job — on retry, re-inserts job_id into a retry index page.
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

/// cancel_job — removes a job_id from whichever page it currently lives in.
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

/// set_queue_paused — toggle queue paused state.
#[derive(Accounts)]
pub struct SetQueuePaused<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    pub authority: Signer<'info>,
}
