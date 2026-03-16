use anchor_lang::prelude::*;

#[error_code]
pub enum JobQueueError {
    #[msg("Queue name must be between 1 and 32 characters")]
    NameTooLong,

    #[msg("max_retries cannot exceed 10")]
    InvalidRetries,

    #[msg("Priority must be 0 (low), 1 (normal), or 2 (high)")]
    InvalidPriority,

    #[msg("Payload exceeds 512 byte limit")]
    PayloadTooLarge,

    #[msg("Result or error message exceeds 128 character limit")]
    ResultTooLarge,

    #[msg("Job must be in Pending status to be claimed")]
    JobNotPending,

    #[msg("Job must be in Processing status to complete or fail")]
    JobNotProcessing,

    #[msg("Job execute_after time has not been reached yet")]
    JobNotReady,

    #[msg("Signer is not authorized for this operation")]
    Unauthorized,

    #[msg("Job is in a terminal state and cannot be cancelled")]
    CannotCancel,

    #[msg("Queue is paused — no new jobs can be enqueued")]
    QueuePaused,

    #[msg("Queue job_count overflow — this queue has processed u64::MAX jobs")]
    QueueFull,

    #[msg("Counter overflow")]
    Overflow,

    #[msg("Index is full — maximum number of entries reached")]
    IndexFull,

    #[msg("Job ID was not found in the specified index")]
    JobNotInIndex,
}
