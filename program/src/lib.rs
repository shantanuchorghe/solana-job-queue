use anchor_lang::prelude::*;

declare_id!("BuG2BPUX7iFZ34Q7yEiFdAdFifXmkr4of1AvLtmnBpas");

// ─────────────────────────────────────────────────────────────────────────────
// SolQueue — On-Chain Job Queue Program
//
// Web2 equivalent: Bull/BullMQ (Redis), AWS SQS, Celery + RabbitMQ
//
// Each "queue" is a PDA account owned by an authority.
// Each "job" is its own PDA keyed by (queue_pubkey, job_id).
// Workers are permissioned via on-chain signer checks — no API gateway,
// no Redis, no message broker. Just accounts and instructions.
//
// State Machine:
//   Pending → Processing → Completed
//                       ↘ Failed (retries exhausted)
//                       ↗ Pending (retry with backoff)
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
    ///
    /// Web2: `new Queue('email-jobs', { connection: redisConfig })`
    /// Solana: Creates a PDA keyed by (authority, queue_name).
    ///         The queue account stores metadata and a monotonic job counter.
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

    /// Enqueue a job with optional scheduling and priority.
    ///
    /// Web2: `await emailQueue.add('send-welcome', { to: 'user@example.com' }, { priority: 1 })`
    ///       → Redis LPUSH / SQS SendMessage
    /// Solana: Creates a Job PDA keyed by (queue_pubkey, job_id u64).
    ///         Payload stored as raw bytes (max 512 bytes).
    ///         `execute_after` enables cron-style delayed execution
    ///         without any external scheduler process.
    pub fn enqueue_job(
        ctx: Context<EnqueueJob>,
        payload: Vec<u8>,
        job_type: String,
        priority: u8,        // 0=low 1=normal 2=high
        execute_after: i64,  // Unix ts; 0 = immediate
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
    ///
    /// Web2: `const job = await worker.getNextJob()`
    ///       → Redis atomic BRPOPLPUSH pending→processing (prevents double-claim)
    /// Solana: Worker signs the tx. Job status flips Pending → Processing.
    ///         Worker pubkey is stamped on the job account — no other worker
    ///         can complete or fail it. Replaces distributed locks entirely.
    ///         The blockchain itself is the mutex.
    pub fn claim_job(ctx: Context<ClaimJob>) -> Result<()> {
        let job   = &mut ctx.accounts.job;
        let clock = Clock::get()?;

        require!(job.status == JobStatus::Pending, JobQueueError::JobNotPending);
        require!(clock.unix_timestamp >= job.execute_after, JobQueueError::JobNotReady);

        job.status     = JobStatus::Processing;
        job.worker     = Some(ctx.accounts.worker.key());
        job.started_at = Some(clock.unix_timestamp);
        job.attempts   = job.attempts.checked_add(1).unwrap_or(u8::MAX);

        emit!(JobClaimed {
            queue:      job.queue,
            job_id:     job.job_id,
            worker:     ctx.accounts.worker.key(),
            attempt:    job.attempts,
            claimed_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Mark a job as completed and write the result on-chain.
    ///
    /// Web2: `await job.moveToCompleted('{"sent":true}', true)`
    ///       → Redis DEL active:job, ZADD completed:job score=ts
    /// Solana: Only the claiming worker can call this — enforced by
    ///         comparing job.worker == signer. Result stored on the
    ///         job account, readable by anyone, forever, trustlessly.
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

        job.status       = JobStatus::Completed;
        job.completed_at = Some(clock.unix_timestamp);
        job.result       = result.clone();

        queue.pending_count = queue.pending_count.saturating_sub(1);
        queue.processed_count = queue.processed_count
            .checked_add(1)
            .ok_or(JobQueueError::Overflow)?;

        emit!(JobCompleted {
            queue:        queue.key(),
            job_id:       job.job_id,
            worker:       ctx.accounts.worker.key(),
            result,
            completed_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Fail a job — triggers automatic retry with exponential backoff.
    ///
    /// Web2: `await job.moveToFailed({ message: 'SMTP timeout' })`
    ///       → Bull checks attempts < maxRetries, re-queues with delay
    /// Solana: Identical retry logic, fully on-chain state machine.
    ///         If attempts < max_retries → status reverts to Pending,
    ///         execute_after = now + (retry_after * 2^attempt) (backoff).
    ///         If exhausted → JobStatus::Failed (dead letter queue equivalent).
    ///         No external scheduler, no Redis TTL, no cron job required.
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

        job.error_message = Some(error_message.clone());

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

            emit!(JobRetrying {
                queue:    queue.key(),
                job_id:   job.job_id,
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
                job_id:    job.job_id,
                attempts:  job.attempts,
                error:     error_message,
                failed_at: clock.unix_timestamp,
            });
        }

        Ok(())
    }

    /// Cancel a pending or processing job (queue authority only).
    ///
    /// Web2: `await queue.remove(jobId)` — Redis DEL + LREM
    /// Solana: Authority-gated cancel. Only queue.authority can cancel.
    ///         This is analogous to an admin console "remove job" action,
    ///         enforced cryptographically — no admin password needed.
    pub fn cancel_job(ctx: Context<CancelJob>) -> Result<()> {
        let clock = Clock::get()?;
        let queue = &mut ctx.accounts.queue;
        let job   = &mut ctx.accounts.job;

        require!(ctx.accounts.authority.key() == queue.authority, JobQueueError::Unauthorized);
        require!(
            job.status == JobStatus::Pending || job.status == JobStatus::Processing,
            JobQueueError::CannotCancel
        );

        job.status       = JobStatus::Cancelled;
        job.completed_at = Some(clock.unix_timestamp);
        queue.pending_count = queue.pending_count.saturating_sub(1);

        emit!(JobCancelled {
            queue:        queue.key(),
            job_id:       job.job_id,
            cancelled_by: ctx.accounts.authority.key(),
            cancelled_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Pause or resume a queue.
    ///
    /// Web2: `await queue.pause()` / `await queue.resume()`
    ///       → Bull sets queue:paused = 1 in Redis
    /// Solana: Single boolean on queue PDA. Checked atomically in enqueue_job.
    ///         Workers should check queue.paused before claim_job off-chain.
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

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimJob<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,

    pub worker: Signer<'info>,
}

#[derive(Accounts)]
pub struct CompleteJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    #[account(mut, has_one = queue)]
    pub job: Account<'info, Job>,

    pub worker: Signer<'info>,
}

#[derive(Accounts)]
pub struct FailJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    #[account(mut, has_one = queue)]
    pub job: Account<'info, Job>,

    pub worker: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelJob<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    #[account(mut, has_one = queue)]
    pub job: Account<'info, Job>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetQueuePaused<'info> {
    #[account(mut)]
    pub queue: Account<'info, Queue>,

    pub authority: Signer<'info>,
}
