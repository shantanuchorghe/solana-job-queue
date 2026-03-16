use anchor_lang::prelude::*;

declare_id!("BuG2BPUX7iFZ34Q7yEiFdAdFifXmkr4of1AvLtmnBpas");

// ─────────────────────────────────────────────────────────────────────────────
// SolQueue — On-Chain Job Queue Program
//
// Web2 equivalent: Bull/BullMQ (Redis), AWS SQS, Celery + RabbitMQ
//
// Each "queue" is a PDA account owned by an authority.
// Each "job" is its own PDA keyed by (queue_pubkey, job_id).
// Each "index" is a PDA that tracks job IDs by status for O(1) lookups.
// Workers are permissioned via on-chain signer checks — no API gateway,
// no Redis, no message broker. Just accounts and instructions.
//
// State Machine:
//   Pending → Processing → Completed
//                        ↘ Failed (retries exhausted)
//                        ↗ Pending (retry with backoff → delayed index)
//              Cancelled (authority only)
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

    /// Initialize a named queue.
    pub fn initialize_queue(
        ctx: Context<InitializeQueue>,
        queue_name: String,
        max_retries: u8,
    ) -> Result<()> {
        require!(queue_name.len() > 0 && queue_name.len() <= 32, JobQueueError::NameTooLong);
        require!(max_retries <= 10, JobQueueError::InvalidRetries);

        let queue = &mut ctx.accounts.queue;
        queue.authority     = ctx.accounts.authority.key();
        queue.name          = queue_name.clone();
        queue.job_count     = 0;
        queue.pending_count = 0;
        queue.processed_count = 0;
        queue.failed_count  = 0;
        queue.max_retries   = max_retries;
        queue.paused        = false;
        queue.created_at    = Clock::get()?.unix_timestamp;
        queue.bump          = ctx.bumps.queue;

        emit!(QueueCreated {
            authority: queue.authority,
            name: queue_name,
            timestamp: queue.created_at,
        });

        Ok(())
    }

    /// Initialize all 6 job index PDAs for a queue.
    /// Must be called once after initialize_queue, before enqueuing any jobs.
    pub fn initialize_indexes(ctx: Context<InitializeIndexes>) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.queue.authority,
            JobQueueError::Unauthorized
        );

        let queue_key = ctx.accounts.queue.key();

        let pending = &mut ctx.accounts.pending_index;
        pending.queue = queue_key;
        pending.job_ids = Vec::new();
        pending.bump = ctx.bumps.pending_index;

        let processing = &mut ctx.accounts.processing_index;
        processing.queue = queue_key;
        processing.job_ids = Vec::new();
        processing.bump = ctx.bumps.processing_index;

        let delayed = &mut ctx.accounts.delayed_index;
        delayed.queue = queue_key;
        delayed.job_ids = Vec::new();
        delayed.bump = ctx.bumps.delayed_index;

        let failed = &mut ctx.accounts.failed_index;
        failed.queue = queue_key;
        failed.job_ids = Vec::new();
        failed.bump = ctx.bumps.failed_index;

        let completed = &mut ctx.accounts.completed_index;
        completed.queue = queue_key;
        completed.job_ids = Vec::new();
        completed.bump = ctx.bumps.completed_index;

        let cancelled = &mut ctx.accounts.cancelled_index;
        cancelled.queue = queue_key;
        cancelled.job_ids = Vec::new();
        cancelled.bump = ctx.bumps.cancelled_index;

        Ok(())
    }

    /// Enqueue a job with optional scheduling and priority.
    /// Atomically pushes the job ID into the pending index.
    pub fn enqueue_job(
        ctx: Context<EnqueueJob>,
        payload: Vec<u8>,
        job_type: String,
        priority: u8,
        execute_after: i64,
    ) -> Result<()> {
        require!(payload.len() <= 512, JobQueueError::PayloadTooLarge);
        require!(job_type.len() > 0 && job_type.len() <= 32, JobQueueError::NameTooLong);
        require!(priority <= 2, JobQueueError::InvalidPriority);
        require!(!ctx.accounts.queue.paused, JobQueueError::QueuePaused);

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

        // Atomically add to pending index
        ctx.accounts.pending_index.push_job(job_id)?;

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

    /// Claim a job — worker atomically locks it for processing.
    /// Removes the job ID from pending or delayed index and pushes to processing index.
    pub fn claim_job(ctx: Context<ClaimJob>) -> Result<()> {
        let job   = &mut ctx.accounts.job;
        let clock = Clock::get()?;

        require!(job.status == JobStatus::Pending, JobQueueError::JobNotPending);
        require!(clock.unix_timestamp >= job.execute_after, JobQueueError::JobNotReady);

        let job_id = job.job_id;

        job.status     = JobStatus::Processing;
        job.worker     = Some(ctx.accounts.worker.key());
        job.started_at = Some(clock.unix_timestamp);
        job.attempts   = job.attempts.checked_add(1).unwrap_or(u8::MAX);

        // Remove from source index (pending or delayed) and push to processing
        if ctx.accounts.pending_index.remove_job(job_id).is_err() {
            ctx.accounts.delayed_index.remove_job(job_id)?;
        }
        ctx.accounts.processing_index.push_job(job_id)?;

        emit!(JobClaimed {
            queue:      job.queue,
            job_id,
            worker:     ctx.accounts.worker.key(),
            attempt:    job.attempts,
            claimed_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Mark a job as completed and write the result on-chain.
    /// Removes from processing index, pushes to completed index.
    pub fn complete_job(
        ctx: Context<CompleteJob>,
        result: Option<String>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let queue = &mut ctx.accounts.queue;
        let job   = &mut ctx.accounts.job;

        require!(job.status == JobStatus::Processing, JobQueueError::JobNotProcessing);
        require!(job.worker == Some(ctx.accounts.worker.key()), JobQueueError::Unauthorized);

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

        // Atomically update indexes
        ctx.accounts.processing_index.remove_job(job_id)?;
        ctx.accounts.completed_index.push_job(job_id)?;

        emit!(JobCompleted {
            queue:        queue.key(),
            job_id,
            worker:       ctx.accounts.worker.key(),
            result,
            completed_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Fail a job — triggers automatic retry with exponential backoff.
    /// Removes from processing index, pushes to delayed (retry) or failed (exhausted) index.
    pub fn fail_job(
        ctx: Context<FailJob>,
        error_message: String,
        retry_after_secs: i64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let queue = &mut ctx.accounts.queue;
        let job   = &mut ctx.accounts.job;

        require!(job.status == JobStatus::Processing, JobQueueError::JobNotProcessing);
        require!(job.worker == Some(ctx.accounts.worker.key()), JobQueueError::Unauthorized);
        require!(error_message.len() <= 128, JobQueueError::ResultTooLarge);

        let job_id = job.job_id;
        job.error_message = Some(error_message.clone());

        // Remove from processing index
        ctx.accounts.processing_index.remove_job(job_id)?;

        if job.attempts < job.max_retries {
            // Exponential backoff: base_delay * 2^(attempt - 1)
            let multiplier = 1i64
                .checked_shl((job.attempts.saturating_sub(1)) as u32)
                .unwrap_or(i64::MAX);
            let backoff = retry_after_secs
                .saturating_mul(multiplier);

            job.status        = JobStatus::Pending;
            job.worker        = None;
            job.started_at    = None;
            job.execute_after = clock.unix_timestamp + backoff;

            // Push to delayed index (retried jobs with backoff)
            ctx.accounts.delayed_index.push_job(job_id)?;

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

            // Push to failed index
            ctx.accounts.failed_index.push_job(job_id)?;

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

    /// Cancel a pending or processing job (queue authority only).
    /// Removes from the appropriate source index, pushes to cancelled index.
    pub fn cancel_job(ctx: Context<CancelJob>) -> Result<()> {
        let clock = Clock::get()?;
        let queue = &mut ctx.accounts.queue;
        let job   = &mut ctx.accounts.job;

        require!(ctx.accounts.authority.key() == queue.authority, JobQueueError::Unauthorized);
        require!(
            job.status == JobStatus::Pending || job.status == JobStatus::Processing,
            JobQueueError::CannotCancel
        );

        let job_id = job.job_id;

        // Remove from the appropriate source index based on current status
        if job.status == JobStatus::Pending {
            if ctx.accounts.pending_index.remove_job(job_id).is_err() {
                ctx.accounts.delayed_index.remove_job(job_id)?;
            }
        } else {
            ctx.accounts.processing_index.remove_job(job_id)?;
        }

        job.status       = JobStatus::Cancelled;
        job.completed_at = Some(clock.unix_timestamp);
        queue.pending_count = queue.pending_count.saturating_sub(1);

        // Push to cancelled index
        ctx.accounts.cancelled_index.push_job(job_id)?;

        emit!(JobCancelled {
            queue:        queue.key(),
            job_id,
            cancelled_by: ctx.accounts.authority.key(),
            cancelled_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Pause or resume a queue.
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

#[derive(Accounts)]
#[instruction(queue_name: String)]
pub struct InitializeQueue<'info> {
    #[account(
        init,
        payer = authority,
        space = Queue::SPACE,
        seeds = [b"queue", authority.key().as_ref(), queue_name.as_bytes()],
        bump
    )]
    pub queue: Account<'info, Queue>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeIndexes<'info> {
    pub queue: Account<'info, Queue>,

    #[account(
        init,
        payer = authority,
        space = JobIndex::SPACE,
        seeds = [b"index", queue.key().as_ref(), INDEX_PENDING],
        bump
    )]
    pub pending_index: Account<'info, JobIndex>,

    #[account(
        init,
        payer = authority,
        space = JobIndex::SPACE,
        seeds = [b"index", queue.key().as_ref(), INDEX_PROCESSING],
        bump
    )]
    pub processing_index: Account<'info, JobIndex>,

    #[account(
        init,
        payer = authority,
        space = JobIndex::SPACE,
        seeds = [b"index", queue.key().as_ref(), INDEX_DELAYED],
        bump
    )]
    pub delayed_index: Account<'info, JobIndex>,

    #[account(
        init,
        payer = authority,
        space = JobIndex::SPACE,
        seeds = [b"index", queue.key().as_ref(), INDEX_FAILED],
        bump
    )]
    pub failed_index: Account<'info, JobIndex>,

    #[account(
        init,
        payer = authority,
        space = JobIndex::SPACE,
        seeds = [b"index", queue.key().as_ref(), INDEX_COMPLETED],
        bump
    )]
    pub completed_index: Account<'info, JobIndex>,

    #[account(
        init,
        payer = authority,
        space = JobIndex::SPACE,
        seeds = [b"index", queue.key().as_ref(), INDEX_CANCELLED],
        bump
    )]
    pub cancelled_index: Account<'info, JobIndex>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnqueueJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    #[account(
        init,
        payer = payer,
        space = Job::SPACE,
        seeds = [b"job", queue.key().as_ref(), &queue.job_count.to_le_bytes()],
        bump
    )]
    pub job: Account<'info, Job>,

    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), INDEX_PENDING],
        bump = pending_index.bump
    )]
    pub pending_index: Account<'info, JobIndex>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimJob<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,

    pub worker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"index", job.queue.as_ref(), INDEX_PENDING],
        bump = pending_index.bump
    )]
    pub pending_index: Account<'info, JobIndex>,

    #[account(
        mut,
        seeds = [b"index", job.queue.as_ref(), INDEX_DELAYED],
        bump = delayed_index.bump
    )]
    pub delayed_index: Account<'info, JobIndex>,

    #[account(
        mut,
        seeds = [b"index", job.queue.as_ref(), INDEX_PROCESSING],
        bump = processing_index.bump
    )]
    pub processing_index: Account<'info, JobIndex>,
}

#[derive(Accounts)]
pub struct CompleteJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    #[account(mut, has_one = queue)]
    pub job: Account<'info, Job>,

    pub worker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), INDEX_PROCESSING],
        bump = processing_index.bump
    )]
    pub processing_index: Account<'info, JobIndex>,

    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), INDEX_COMPLETED],
        bump = completed_index.bump
    )]
    pub completed_index: Account<'info, JobIndex>,
}

#[derive(Accounts)]
pub struct FailJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    #[account(mut, has_one = queue)]
    pub job: Account<'info, Job>,

    pub worker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), INDEX_PROCESSING],
        bump = processing_index.bump
    )]
    pub processing_index: Account<'info, JobIndex>,

    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), INDEX_DELAYED],
        bump = delayed_index.bump
    )]
    pub delayed_index: Account<'info, JobIndex>,

    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), INDEX_FAILED],
        bump = failed_index.bump
    )]
    pub failed_index: Account<'info, JobIndex>,
}

#[derive(Accounts)]
pub struct CancelJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    #[account(mut, has_one = queue)]
    pub job: Account<'info, Job>,

    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), INDEX_PENDING],
        bump = pending_index.bump
    )]
    pub pending_index: Account<'info, JobIndex>,

    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), INDEX_DELAYED],
        bump = delayed_index.bump
    )]
    pub delayed_index: Account<'info, JobIndex>,

    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), INDEX_PROCESSING],
        bump = processing_index.bump
    )]
    pub processing_index: Account<'info, JobIndex>,

    #[account(
        mut,
        seeds = [b"index", queue.key().as_ref(), INDEX_CANCELLED],
        bump = cancelled_index.bump
    )]
    pub cancelled_index: Account<'info, JobIndex>,
}

#[derive(Accounts)]
pub struct SetQueuePaused<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    pub authority: Signer<'info>,
}
