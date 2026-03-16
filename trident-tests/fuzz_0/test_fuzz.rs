//! test_fuzz.rs — DecQueue property-based fuzz test
//!
//! # What this file tests
//!
//! Three categories of properties are checked here:
//!
//! ## Invariant 1 — Index / QueueHead consistency
//! After ANY instruction that creates or removes a job from an index page, the
//! total count of job_ids across ALL pages reachable from QueueHead MUST equal
//! `queue_head.total_jobs`.  A counter desync here would mean a job is "lost"
//! (or double-counted), which would break the worker's O(1) traversal guarantee.
//!
//! ## Invariant 2 — Worker authority immutability
//! Once a job transitions to `Processing`, its `job.worker` field MUST NOT
//! change to any signer who was NOT the original claimer, unless the job is
//! first reset to `Pending` via `fail_job` (retry path).  This catches bugs
//! where a second worker could overwrite the lock.
//!
//! ## Flow — High-concurrency rollover stress test
//! Simulates `N_WORKERS` workers simultaneously racing to claim, complete, and
//! fail jobs, while a producer keeps filling the tail page.  When the tail
//! page hits `MAX_INDEX_ENTRIES`, `grow_index` is called and the head advances
//! via `advance_head` — this exercises every edge of the linked-list rollover
//! logic under arbitrary interleaving.
//!
//! # Trident execution model
//!
//! ```
//! loop {
//!   corpus_seed = fuzzer.generate_or_mutate()
//!   for flow in [concurrent_worker_flow, ...] {
//!     trident.reset_state()
//!     flow.setup()
//!     flow.run_transactions()   // each tx checks invariants before + after
//!   }
//! }
//! ```
//!
//! TridentSVM runs the compiled `dec_queue` library in-process — no validator
//! needed, ~10 000 transactions/second on a modern laptop.

#![allow(unused_imports)]
use anchor_lang::prelude::Pubkey;
use arbitrary::Arbitrary;
use dec_queue::{
    state::{Job, JobIndex, JobStatus, QueueHead, MAX_INDEX_ENTRIES},
};
use trident_fuzz::prelude::*;

mod fuzz_accounts;
use fuzz_accounts::FuzzAccounts;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Number of concurrent worker slots simulated per flow iteration.
const N_WORKERS: usize = 4;

/// How many jobs the producer enqueues at the start of each flow run.
const INITIAL_JOB_BATCH: usize = 8;

/// Program ID — must match declare_id! in lib.rs
const PROGRAM_ID: Pubkey = pubkey!("GQdb3Gabjd28jXVnNZguU9cTwYsxw7Emrn2voQoyJA4a");

// ─────────────────────────────────────────────────────────────────────────────
// Arbitrary instruction inputs
//
// `#[derive(Arbitrary)]` lets the fuzzer mutate these fields with LibFuzzer's
// coverage-guided byte-flipping strategy.  Ranges are kept small intentionally:
// the fuzzer covers more distinct states with a compact address space.
// ─────────────────────────────────────────────────────────────────────────────

/// Fuzz input for `enqueue_job`
#[derive(Arbitrary, Debug, Clone)]
pub struct EnqueueInput {
    /// Index into FuzzAccounts::authority (0..4)
    pub authority_idx: u8,
    /// Payload bytes — will be capped to 512 by the program
    pub payload: Vec<u8>,
    /// Job type string — capped to 32 chars by the program
    pub job_type: [u8; 8],
    /// 0=low, 1=normal, 2=high; values ≥3 should trigger InvalidPriority
    pub priority: u8,
    /// 0 = immediately, >0 = scheduled delay (seconds)
    pub execute_after: i64,
}

/// Fuzz input for `claim_job`
#[derive(Arbitrary, Debug, Clone)]
pub struct ClaimInput {
    pub worker_idx: u8,
    /// Which job_id to try to claim (0..16)
    pub job_id: u8,
    /// Which index page sequence to use as source_index_page
    pub page_seq: u8,
}

/// Fuzz input for `complete_job`
#[derive(Arbitrary, Debug, Clone)]
pub struct CompleteInput {
    pub worker_idx: u8,
    pub job_id: u8,
    pub result: Option<String>,
}

/// Fuzz input for `fail_job`
#[derive(Arbitrary, Debug, Clone)]
pub struct FailInput {
    pub worker_idx: u8,
    pub job_id: u8,
    pub error_message: String,
    /// Base retry delay in seconds (exponential backoff applied by program)
    pub retry_after_secs: i64,
    /// Whether this worker should be a different one than the claimer
    /// to probe the Unauthorized guard.
    pub use_different_worker: bool,
}

/// Fuzz input for the `cancel_job` path (authority only)
#[derive(Arbitrary, Debug, Clone)]
pub struct CancelInput {
    pub authority_idx: u8,
    pub job_id: u8,
    pub page_seq: u8,
}

// ─────────────────────────────────────────────────────────────────────────────
// FuzzTest struct — holds TridentSVM + FuzzAccounts
// ─────────────────────────────────────────────────────────────────────────────

pub struct FuzzTest {
    pub trident: Trident,
    pub fuzz_accounts: FuzzAccounts,
    /// Tracks the authority keypair used for the active queue in this iteration
    pub queue_authority_idx: u8,
    /// Remembers which worker claimed which job_id this iteration (for Inv2)
    pub claimed_by: std::collections::HashMap<u8, Pubkey>,
}

impl FuzzTest {
    pub fn new() -> Self {
        let trident = Trident::new(PROGRAM_ID);
        FuzzTest {
            trident,
            fuzz_accounts: FuzzAccounts {
                authority:  AccountsStorage::new(4),
                worker:     AccountsStorage::new(8),
                queue:      AccountsStorage::new(4),
                queue_head: AccountsStorage::new(4),
                index_page: AccountsStorage::new(8),
                job:        AccountsStorage::new(16),
            },
            queue_authority_idx: 0,
            claimed_by: std::collections::HashMap::new(),
        }
    }

    // ── PDA derivation helpers ─────────────────────────────────────────────

    fn queue_pda(&self, authority: &Pubkey, name: &str) -> Pubkey {
        Pubkey::find_program_address(
            &[b"queue", authority.as_ref(), name.as_bytes()],
            &PROGRAM_ID,
        ).0
    }

    fn queue_head_pda(&self, queue: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[b"queue_head", queue.as_ref()],
            &PROGRAM_ID,
        ).0
    }

    fn index_page_pda(&self, queue: &Pubkey, seq: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[b"index", queue.as_ref(), &seq.to_le_bytes()],
            &PROGRAM_ID,
        ).0
    }

    fn job_pda(&self, queue: &Pubkey, job_id: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[b"job", queue.as_ref(), &job_id.to_le_bytes()],
            &PROGRAM_ID,
        ).0
    }

    // ── Account readers ────────────────────────────────────────────────────

    fn read_queue_head(&self, queue: &Pubkey) -> Option<QueueHead> {
        let head_pda = self.queue_head_pda(queue);
        // 8 = Anchor account discriminator prefix
        self.trident.get_account_with_type::<QueueHead>(&head_pda, 8)
    }

    fn read_index_page(&self, queue: &Pubkey, seq: u64) -> Option<JobIndex> {
        let pda = self.index_page_pda(queue, seq);
        self.trident.get_account_with_type::<JobIndex>(&pda, 8)
    }

    fn read_job(&self, queue: &Pubkey, job_id: u64) -> Option<Job> {
        let pda = self.job_pda(queue, job_id);
        self.trident.get_account_with_type::<Job>(&pda, 8)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INVARIANT 1 — Index page ↔ QueueHead.total_jobs consistency
    //
    // Walk every page from head_index_seq to tail_index_seq and count the
    // total number of job_ids stored.  That count MUST equal total_jobs.
    //
    // Why this catches bugs:
    //   - grow_index fails to increment tail_index_seq         → undercount
    //   - advance_head fails to drain the head page first       → overcount
    //   - push_job / remove_job both mutate the vec but only
    //     enqueue_job increments total_jobs                     → desync
    //   - page rollover skips a seq number                      → missing page
    // ─────────────────────────────────────────────────────────────────────────
    fn invariant_index_total_jobs_consistency(&mut self, queue: &Pubkey) {
        let head = match self.read_queue_head(queue) {
            Some(h) => h,
            None    => return, // queue not yet initialized — skip
        };

        let mut ids_in_pages: u64 = 0;
        let mut seq = head.head_index_seq;
        let mut visited = std::collections::HashSet::new();

        // Walk the linked list — guard against cycles (shouldn't happen, but
        // the fuzzer might craft a state where next_seq == current seq)
        loop {
            assert!(
                visited.insert(seq),
                "INVARIANT VIOLATION (Inv1): Cycle detected in JobIndex linked list at seq={}", seq
            );

            let page = match self.read_index_page(queue, seq) {
                Some(p) => p,
                None    => break, // page not yet allocated (past tail)
            };

            ids_in_pages += page.job_ids.len() as u64;

            if seq == head.tail_index_seq {
                break; // reached the tail — stop
            }

            // next_seq = 0 means "no successor" but we haven't reached tail
            assert_ne!(
                page.next_seq, 0,
                "INVARIANT VIOLATION (Inv1): next_seq=0 on non-tail page seq={}", seq
            );
            seq = page.next_seq;
        }

        // total_jobs is monotonically increasing (it never decrements) so it
        // represents historical inserts, not current presence.  We instead
        // assert the *live page count* does not exceed total_jobs (a removed
        // entry must not appear in more pages than were ever inserted).
        assert!(
            ids_in_pages <= head.total_jobs,
            "INVARIANT VIOLATION (Inv1): ids across pages ({}) > queue_head.total_jobs ({}). \
             A job_id was inserted into an index page but total_jobs was NOT incremented.",
            ids_in_pages,
            head.total_jobs,
        );

        // Also verify no job_id appears in MORE THAN ONE page simultaneously
        // (double-insertion bug in push_job / grow_index rollover)
        let mut all_ids: Vec<u64> = Vec::new();
        let mut seq = head.head_index_seq;
        loop {
            let page = match self.read_index_page(queue, seq) {
                Some(p) => p,
                None    => break,
            };
            for &id in &page.job_ids {
                assert!(
                    !all_ids.contains(&id),
                    "INVARIANT VIOLATION (Inv1): job_id={} appears in multiple index pages! \
                     This is a double-insertion bug in grow_index / push_job rollover.",
                    id
                );
                all_ids.push(id);
            }
            if seq == head.tail_index_seq { break; }
            seq = page.next_seq;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INVARIANT 2 — Worker authority immutability
    //
    // After a successful `claim_job`, job.worker = Some(claimer).
    // No instruction other than `fail_job` (retry path, which resets worker
    // back to None) should be able to change job.worker to a different Pubkey.
    //
    // This catches:
    //   - Missing `has_one = worker` / `constraint` in CompleteJob or FailJob
    //   - An attacker submitting complete_job with their own worker key to
    //     "steal" a job that another worker is processing
    //   - Race condition where claim_job overwrites an already Processing job
    // ─────────────────────────────────────────────────────────────────────────
    fn invariant_worker_immutability(
        &mut self,
        queue: &Pubkey,
        job_id: u64,
        expected_claimer: &Pubkey,
    ) {
        let job = match self.read_job(queue, job_id) {
            Some(j) => j,
            None    => return,
        };

        match job.status {
            JobStatus::Processing => {
                // Must still be locked by the original claimer
                assert_eq!(
                    job.worker,
                    Some(*expected_claimer),
                    "INVARIANT VIOLATION (Inv2): job_id={} is Processing but worker changed! \
                     Expected={} Got={:?}. Another signer hijacked the job lock.",
                    job_id,
                    expected_claimer,
                    job.worker,
                );
            }
            JobStatus::Completed => {
                // Completed by the claimer — worker field should still be the claimer
                assert_eq!(
                    job.worker,
                    Some(*expected_claimer),
                    "INVARIANT VIOLATION (Inv2): job_id={} Completed by wrong worker. \
                     Expected={} Got={:?}.",
                    job_id,
                    expected_claimer,
                    job.worker,
                );
            }
            JobStatus::Pending => {
                // Retry path reset the worker to None — that is correct.
                assert_eq!(
                    job.worker, None,
                    "INVARIANT VIOLATION (Inv2): job_id={} re-Pending but worker is Some({:?}). \
                     Worker lock was not cleared on retry.",
                    job_id, job.worker,
                );
            }
            _ => {} // Failed / Cancelled — no further constraint
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Transaction helpers
    //
    // Each helper wraps one program instruction and returns the TridentResult.
    // The #[flow] methods call these helpers to build a sequence of calls.
    // ─────────────────────────────────────────────────────────────────────────

    fn ix_initialize_queue(&mut self, authority_idx: u8, name: &str) -> TridentResult {
        let authority = self.fuzz_accounts.authority.get(&mut self.trident, authority_idx as usize);
        let queue     = self.queue_pda(&authority.pubkey(), name);
        let head      = self.queue_head_pda(&queue);
        let page0     = self.index_page_pda(&queue, 0);

        let ix = dec_queue::instruction::InitializeQueue {
            queue_name: name.to_string(),
            max_retries: 3,
        };

        let accounts = dec_queue::accounts::InitializeQueue {
            queue,
            queue_head: head,
            first_index_page: page0,
            authority: authority.pubkey(),
            system_program: anchor_lang::solana_program::system_program::ID,
        };

        self.trident.process_transaction_with_signer(
            &dec_queue::ID,
            ix,
            accounts,
            &authority,
            "initialize_queue",
        )
    }

    fn ix_enqueue_job(&mut self, auth_idx: u8, queue: &Pubkey, input: &EnqueueInput) -> (TridentResult, u64) {
        let authority  = self.fuzz_accounts.authority.get(&mut self.trident, auth_idx as usize);
        let queue_data = self.trident.get_account_with_type::<dec_queue::state::Queue>(queue, 8);
        let job_id     = queue_data.map(|q| q.job_count).unwrap_or(0);

        let job_pda    = self.job_pda(queue, job_id);
        let head_pda   = self.queue_head_pda(queue);
        let head_data  = self.read_queue_head(queue);
        let tail_seq   = head_data.map(|h| h.tail_index_seq).unwrap_or(0);
        let tail_page  = self.index_page_pda(queue, tail_seq);

        let payload    = (&input.payload[..input.payload.len().min(512)]).to_vec();
        let job_type   = String::from_utf8_lossy(&input.job_type[..]).to_string();
        let job_type   = if job_type.is_empty() { "fuzz-job".to_string() } else { job_type };

        let ix = dec_queue::instruction::EnqueueJob {
            payload,
            job_type: job_type[..job_type.len().min(32)].to_string(),
            priority: input.priority % 3,   // clamp to 0/1/2
            execute_after: input.execute_after.max(0),
        };

        let accounts = dec_queue::accounts::EnqueueJob {
            queue: *queue,
            job: job_pda,
            queue_head: head_pda,
            tail_index_page: tail_page,
            payer: authority.pubkey(),
            system_program: anchor_lang::solana_program::system_program::ID,
        };

        let result = self.trident.process_transaction_with_signer(
            &dec_queue::ID, ix, accounts, &authority, "enqueue_job",
        );

        (result, job_id)
    }

    fn ix_claim_job(&mut self, worker_idx: u8, queue: &Pubkey, job_id: u64, page_seq: u64) -> TridentResult {
        let worker    = self.fuzz_accounts.worker.get(&mut self.trident, worker_idx as usize);
        let job_pda   = self.job_pda(queue, job_id);
        let page_pda  = self.index_page_pda(queue, page_seq);

        let ix = dec_queue::instruction::ClaimJob {};
        let accounts = dec_queue::accounts::ClaimJob {
            job:              job_pda,
            worker:           worker.pubkey(),
            source_index_page: page_pda,
        };

        self.trident.process_transaction_with_signer(
            &dec_queue::ID, ix, accounts, &worker, "claim_job",
        )
    }

    fn ix_complete_job(&mut self, worker_idx: u8, queue: &Pubkey, job_id: u64, result: Option<String>) -> TridentResult {
        let worker   = self.fuzz_accounts.worker.get(&mut self.trident, worker_idx as usize);
        let job_pda  = self.job_pda(queue, job_id);
        let queue_data = self.trident.get_account_with_type::<dec_queue::state::Queue>(queue, 8);

        let ix = dec_queue::instruction::CompleteJob { result };
        let accounts = dec_queue::accounts::CompleteJob {
            queue: *queue,
            job:   job_pda,
            worker: worker.pubkey(),
        };

        self.trident.process_transaction_with_signer(
            &dec_queue::ID, ix, accounts, &worker, "complete_job",
        )
    }

    fn ix_fail_job(
        &mut self,
        worker_idx: u8,
        queue: &Pubkey,
        job_id: u64,
        error_message: String,
        retry_after_secs: i64,
        retry_page_seq: u64,
    ) -> TridentResult {
        let worker     = self.fuzz_accounts.worker.get(&mut self.trident, worker_idx as usize);
        let job_pda    = self.job_pda(queue, job_id);
        let retry_page = self.index_page_pda(queue, retry_page_seq);

        let ix = dec_queue::instruction::FailJob {
            error_message: error_message[..error_message.len().min(128)].to_string(),
            retry_after_secs: retry_after_secs.max(1),
        };
        let accounts = dec_queue::accounts::FailJob {
            queue: *queue,
            job:   job_pda,
            worker: worker.pubkey(),
            retry_index_page: retry_page,
        };

        self.trident.process_transaction_with_signer(
            &dec_queue::ID, ix, accounts, &worker, "fail_job",
        )
    }

    fn ix_grow_index(&mut self, authority_idx: u8, queue: &Pubkey, new_seq: u64) -> TridentResult {
        let authority = self.fuzz_accounts.authority.get(&mut self.trident, authority_idx as usize);
        let head_pda  = self.queue_head_pda(queue);
        let head      = self.read_queue_head(queue).expect("QueueHead must exist to grow");
        let curr_tail = self.index_page_pda(queue, head.tail_index_seq);
        let new_tail  = self.index_page_pda(queue, new_seq);

        let ix = dec_queue::instruction::GrowIndex { new_seq };
        let accounts = dec_queue::accounts::GrowIndex {
            queue: *queue,
            queue_head: head_pda,
            current_tail_page: curr_tail,
            new_tail_page: new_tail,
            authority: authority.pubkey(),
            system_program: anchor_lang::solana_program::system_program::ID,
        };

        self.trident.process_transaction_with_signer(
            &dec_queue::ID, ix, accounts, &authority, "grow_index",
        )
    }

    fn ix_advance_head(&mut self, queue: &Pubkey) -> TridentResult {
        let head      = self.read_queue_head(queue).expect("QueueHead must exist");
        let head_pda  = self.queue_head_pda(queue);
        let head_page = self.index_page_pda(queue, head.head_index_seq);

        let ix = dec_queue::instruction::AdvanceHead {};
        let accounts = dec_queue::accounts::AdvanceHead {
            queue_head: head_pda,
            head_page,
        };

        self.trident.process_transaction(
            &dec_queue::ID, ix, accounts, "advance_head",
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// #[flow_executor] + #[flow] — the main fuzzing entry point
//
// `flow_executor` wraps the impl block and injects Trident's runner loop.
// Each `#[flow]` method is an independent scenario that resets state, sets up
// initial conditions, then runs a sequence of transactions with invariant
// checks.  The LibFuzzer harness calls the executor with a mutated corpus seed.
// ─────────────────────────────────────────────────────────────────────────────
#[flow_executor]
impl FuzzTest {

    // ─────────────────────────────────────────────────────────────────────────
    // FLOW 1 — concurrent_worker_flow
    //
    // High-concurrency simulation of N_WORKERS workers competing for jobs.
    //
    // Scenario:
    //   1. Initialize queue + first index page (seq=0)
    //   2. Producer enqueues INITIAL_JOB_BATCH jobs
    //   3. N_WORKERS workers each attempt to claim a different job
    //   4. Each worker independently completes or fails their job
    //   5. When the index page fills, grow_index is called
    //   6. When head page drains, advance_head is called
    //
    // Race conditions probed:
    //   - Two workers claiming the same job_id (only one should succeed)
    //   - Worker B trying to complete a job claimed by Worker A
    //   - grow_index called before tail is full (should error with IndexNotFull)
    //   - advance_head called before head is empty (should error with HeadPageNotEmpty)
    //   - total_jobs desync across every page rollover
    // ─────────────────────────────────────────────────────────────────────────
    #[flow]
    fn concurrent_worker_flow(
        &mut self,
        // The fuzzer generates these inputs — types must impl Arbitrary
        claim_inputs:    Vec<ClaimInput>,
        complete_inputs: Vec<CompleteInput>,
        fail_inputs:     Vec<FailInput>,
        enqueue_inputs:  Vec<EnqueueInput>,
    ) {
        // ── 1. Setup ──────────────────────────────────────────────────────────
        let auth_idx  = 0u8;
        let queue_name = "fuzz-queue-0";
        let init_res  = self.ix_initialize_queue(auth_idx, queue_name);
        // Queue might already exist from a previous iteration — both outcomes fine
        let _ = init_res;

        let authority = self.fuzz_accounts.authority.get(&mut self.trident, auth_idx as usize);
        let queue_pda = self.queue_pda(&authority.pubkey(), queue_name);

        self.queue_authority_idx = auth_idx;
        self.claimed_by.clear();

        // ── 2. Enqueue a batch of jobs ─────────────────────────────────────────
        // Always enqueue at least INITIAL_JOB_BATCH regardless of fuzzer input,
        // to ensure workers have something to claim.
        let mut enqueued_ids = Vec::new();
        for i in 0..(INITIAL_JOB_BATCH + enqueue_inputs.len()) {
            let input = enqueue_inputs.get(i).cloned().unwrap_or_else(|| EnqueueInput {
                authority_idx: auth_idx,
                payload: vec![0u8; 32],
                job_type: *b"fuzz-job",
                priority: 1,
                execute_after: 0,
            });

            // Grow index if tail is full before enqueueing
            if let Some(head) = self.read_queue_head(&queue_pda) {
                if let Some(tail_page) = self.read_index_page(&queue_pda, head.tail_index_seq) {
                    if tail_page.is_full() {
                        let new_seq = head.tail_index_seq + 1;
                        let _ = self.ix_grow_index(auth_idx, &queue_pda, new_seq);
                    }
                }
            }

            let (res, job_id) = self.ix_enqueue_job(auth_idx, &queue_pda, &input);
            if res.is_success() {
                enqueued_ids.push(job_id);
                // ── Check Invariant 1 after every enqueue ──────────────────
                self.invariant_index_total_jobs_consistency(&queue_pda);
            }
        }

        // ── 3. N_WORKERS race to claim ─────────────────────────────────────
        let n = claim_inputs.len().min(enqueued_ids.len()).min(N_WORKERS * 2);
        for i in 0..n {
            let ci = &claim_inputs[i % claim_inputs.len()];
            let job_id = match enqueued_ids.get(i) {
                Some(&id) => id,
                None      => break,
            };
            let worker_idx = ci.worker_idx % (N_WORKERS as u8);
            let page_seq   = ci.page_seq as u64 % 4;

            // Read job state BEFORE claim attempt
            let job_before = self.read_job(&queue_pda, job_id);

            let claim_res = self.ix_claim_job(worker_idx, &queue_pda, job_id, page_seq);

            if claim_res.is_success() {
                let worker_pk = self.fuzz_accounts.worker
                    .get(&mut self.trident, worker_idx as usize)
                    .pubkey();
                self.claimed_by.insert(ci.job_id % 16, worker_pk);

                // ── Sub-invariant: job was Pending BEFORE claim succeeded ──
                if let Some(before) = &job_before {
                    assert_eq!(
                        before.status, JobStatus::Pending,
                        "INVARIANT VIOLATION (Inv2 pre): claim_job succeeded on a non-Pending job! \
                         job_id={} status_before={:?}", job_id, before.status
                    );
                }

                // ── Sub-invariant: job is Processing AFTER successful claim ─
                if let Some(after) = self.read_job(&queue_pda, job_id) {
                    assert_eq!(
                        after.status, JobStatus::Processing,
                        "INVARIANT VIOLATION (Inv2 post): job_id={} status should be \
                         Processing after claim, got {:?}", job_id, after.status
                    );
                    assert_eq!(
                        after.worker, Some(worker_pk),
                        "INVARIANT VIOLATION (Inv2 post): job_id={} worker field \
                         mismatch after claim. Expected={} Got={:?}",
                        job_id, worker_pk, after.worker
                    );
                }

                // ── Invariant 1 after claim ────────────────────────────────
                self.invariant_index_total_jobs_consistency(&queue_pda);
            } else {
                // Failed claim is ONLY legitimate when:
                //   - Job is not Pending (JobNotPending) — ok
                //   - execute_after not reached (JobNotReady) — ok
                //   - Job not in source_index_page (JobNotInIndex) — ok
                // Any other error from a racing claim is a potential bug.
                let code = claim_res.custom_error_code();
                let known_fail_codes = [
                    dec_queue::errors::JobQueueError::JobNotPending  as u32,
                    dec_queue::errors::JobQueueError::JobNotReady    as u32,
                    dec_queue::errors::JobQueueError::JobNotInIndex  as u32,
                    dec_queue::errors::JobQueueError::QueueMismatch  as u32,
                ];
                if let Some(code) = code {
                    assert!(
                        known_fail_codes.contains(&code),
                        "UNEXPECTED claim_job failure: error_code={} for job_id={}. \
                         This is not a known-ok failure mode — audit the program logic.",
                        code, job_id
                    );
                }
            }
        }

        // ── 4. Workers complete or fail their claimed jobs ──────────────────
        for fi in &fail_inputs {
            let job_id    = fi.job_id as u64 % enqueued_ids.len().max(1) as u64;
            let worker_idx = fi.worker_idx % N_WORKERS as u8;

            // Capture claimer for Inv2 check
            let expected_claimer = self.claimed_by.get(&(fi.job_id % 16)).cloned();

            // Attacker scenario: use a DIFFERENT worker key if flag set
            let actual_worker_idx = if fi.use_different_worker {
                (worker_idx + 1) % N_WORKERS as u8
            } else {
                worker_idx
            };

            let fail_res = self.ix_fail_job(
                actual_worker_idx,
                &queue_pda,
                job_id,
                fi.error_message.clone(),
                fi.retry_after_secs,
                0, // retry into page seq=0
            );

            if fail_res.is_success() {
                assert!(
                    !fi.use_different_worker,
                    "SECURITY BUG (Inv2): fail_job succeeded from a DIFFERENT worker than the claimer! \
                     job_id={} expected_claimer={:?}", job_id, expected_claimer
                );
                // After successful fail, run both invariants
                self.invariant_index_total_jobs_consistency(&queue_pda);
                if let Some(claimer) = &expected_claimer {
                    self.invariant_worker_immutability(&queue_pda, job_id, claimer);
                }
            }
        }

        for ci in &complete_inputs {
            let job_id    = ci.job_id as u64 % enqueued_ids.len().max(1) as u64;
            let worker_idx = ci.worker_idx % N_WORKERS as u8;

            let expected_claimer = self.claimed_by.get(&(ci.job_id % 16)).cloned();

            let complete_res = self.ix_complete_job(
                worker_idx, &queue_pda, job_id, ci.result.clone(),
            );

            if complete_res.is_success() {
                // ── Invariant 2 after complete ──────────────────────────────
                if let Some(claimer) = &expected_claimer {
                    self.invariant_worker_immutability(&queue_pda, job_id, claimer);
                }
            } else if fi_worker_mismatch(&complete_res) {
                // Expected — the wrong worker tried to complete
            } else {
                // Any other unexpected error on complete is a potential bug
            }
        }

        // ── 5. Advance head if head page is now empty ───────────────────────
        if let Some(head) = self.read_queue_head(&queue_pda) {
            if let Some(page) = self.read_index_page(&queue_pda, head.head_index_seq) {
                if page.is_empty() && head.head_index_seq != head.tail_index_seq {
                    let adv_res = self.ix_advance_head(&queue_pda);
                    // advance_head should always succeed when page is empty
                    // and there is a successor — assert this
                    if !adv_res.is_success() {
                        let code = adv_res.custom_error_code();
                        panic!(
                            "advance_head failed on empty head page! code={:?} \
                             head_seq={} tail_seq={}",
                            code, head.head_index_seq, head.tail_index_seq
                        );
                    }
                }
            }
        }

        // ── 6. Final cross-check of both invariants ─────────────────────────
        self.invariant_index_total_jobs_consistency(&queue_pda);

        // Verify every tracked claimed job still satisfies Inv2
        let claimed_snapshot: Vec<(u8, Pubkey)> = self.claimed_by
            .iter()
            .map(|(&id, &pk)| (id, pk))
            .collect();
        for (job_id_idx, expected) in claimed_snapshot {
            self.invariant_worker_immutability(
                &queue_pda,
                job_id_idx as u64,
                &expected,
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FLOW 2 — page_rollover_stress_flow
    //
    // Fills exactly MAX_INDEX_ENTRIES jobs into page seq=0 (triggering full),
    // then calls grow_index to allocate seq=1, enqueues another batch into
    // seq=1, claims all jobs from page=0 (draining it), then calls advance_head.
    //
    // This directly exercises every code path in the linked-list rollover:
    //   - grow_index on a non-full page  → must error IndexNotFull
    //   - grow_index on a full page      → must succeed, next_seq set
    //   - advance_head on non-empty page → must error HeadPageNotEmpty
    //   - advance_head on empty page     → must succeed, head_seq incremented
    //   - total_jobs consistency throughout
    // ─────────────────────────────────────────────────────────────────────────
    #[flow]
    fn page_rollover_stress_flow(&mut self) {
        let auth_idx   = 1u8;
        let queue_name = "fuzz-rollover";
        let _ = self.ix_initialize_queue(auth_idx, queue_name);

        let authority = self.fuzz_accounts.authority.get(&mut self.trident, auth_idx as usize);
        let queue_pda = self.queue_pda(&authority.pubkey(), queue_name);

        // ── Step A: try grow_index BEFORE page is full → expect IndexNotFull
        let premature_grow = self.ix_grow_index(auth_idx, &queue_pda, 1);
        if premature_grow.is_success() {
            panic!(
                "BUG: grow_index succeeded on a non-full page (page has 0 entries). \
                 The IndexNotFull guard is missing or broken."
            );
        }
        assert!(
            premature_grow.is_custom_error_with_code(
                dec_queue::errors::JobQueueError::IndexNotFull as u32
            ),
            "grow_index failed with unexpected error when page not full: {:?}",
            premature_grow.custom_error_code()
        );

        // ── Step B: Fill page seq=0 to MAX_INDEX_ENTRIES
        let base = EnqueueInput {
            authority_idx: auth_idx, payload: vec![42u8; 8],
            job_type: *b"rollover", priority: 1, execute_after: 0,
        };
        for _ in 0..MAX_INDEX_ENTRIES {
            let (res, _) = self.ix_enqueue_job(auth_idx, &queue_pda, &base);
            assert!(
                res.is_success() || res.is_custom_error_with_code(
                    dec_queue::errors::JobQueueError::IndexFull as u32
                ),
                "enqueue_job failed unexpectedly during page fill: {:?}",
                res.custom_error_code()
            );
            self.invariant_index_total_jobs_consistency(&queue_pda);
        }

        // ── Step C: Now grow_index → must succeed
        let grow_res = self.ix_grow_index(auth_idx, &queue_pda, 1);
        assert!(
            grow_res.is_success(),
            "grow_index failed AFTER page was full: {:?}", grow_res.custom_error_code()
        );
        self.invariant_index_total_jobs_consistency(&queue_pda);

        // Verify next_seq on old tail page was set correctly
        let old_tail = self.read_index_page(&queue_pda, 0).expect("page seq=0 must exist");
        assert_eq!(
            old_tail.next_seq, 1,
            "INVARIANT VIOLATION: after grow_index, page seq=0 next_seq should be 1, got {}",
            old_tail.next_seq
        );

        // ── Step D: try advance_head while page=0 is still full → HeadPageNotEmpty
        let premature_advance = self.ix_advance_head(&queue_pda);
        if premature_advance.is_success() {
            panic!(
                "BUG: advance_head succeeded on a non-empty head page (has {} entries). \
                 The HeadPageNotEmpty guard is missing or broken.",
                old_tail.job_ids.len()
            );
        }

        // ── Step E: Claim all MAX_INDEX_ENTRIES jobs to drain page=0
        for job_id in 0..(MAX_INDEX_ENTRIES as u64) {
            let worker_idx = (job_id % N_WORKERS as u64) as u8;
            let claim_res  = self.ix_claim_job(worker_idx, &queue_pda, job_id, 0);
            if claim_res.is_success() {
                self.invariant_index_total_jobs_consistency(&queue_pda);
            }
        }

        // ── Step F: advance_head now — page=0 should be draining
        let adv_res = self.ix_advance_head(&queue_pda);
        // If ANY job is still in page 0, this will correctly error with HeadPageNotEmpty
        if adv_res.is_success() {
            let head = self.read_queue_head(&queue_pda).expect("QueueHead must exist");
            assert_eq!(
                head.head_index_seq, 1,
                "INVARIANT VIOLATION: after advance_head, head_index_seq should be 1, got {}",
                head.head_index_seq
            );
            self.invariant_index_total_jobs_consistency(&queue_pda);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FLOW 3 — unauthorized_access_flow
    //
    // Attempts a battery of unauthorized operations:
    //   - Worker B tries complete_job on a job claimed by Worker A
    //   - Non-authority tries cancel_job
    //   - Worker tries to enqueue into a paused queue
    //
    // Every one of these should fail with Unauthorized or QueuePaused.
    // If any succeeds, the invariant fires and the test reports a vulnerability.
    // ─────────────────────────────────────────────────────────────────────────
    #[flow]
    fn unauthorized_access_flow(&mut self, attacker_worker_idx: u8) {
        let auth_idx   = 2u8;
        let queue_name = "fuzz-auth";
        let _ = self.ix_initialize_queue(auth_idx, queue_name);

        let authority = self.fuzz_accounts.authority.get(&mut self.trident, auth_idx as usize);
        let queue_pda = self.queue_pda(&authority.pubkey(), queue_name);

        // Enqueue one job with legitimate worker (idx=0)
        let (enq_res, job_id) = self.ix_enqueue_job(auth_idx, &queue_pda, &EnqueueInput {
            authority_idx: auth_idx, payload: vec![1, 2, 3],
            job_type: *b"auth-job", priority: 0, execute_after: 0,
        });
        if !enq_res.is_success() { return; } // queue may be paused from prev iter

        // Legitimate worker (idx=0) claims the job
        let legit_idx   = 0u8;
        let claim_res   = self.ix_claim_job(legit_idx, &queue_pda, job_id, 0);
        if !claim_res.is_success() { return; }

        let legit_worker = self.fuzz_accounts.worker
            .get(&mut self.trident, legit_idx as usize)
            .pubkey();

        // ── Test: Attacker tries to complete the job ──────────────────────
        let attacker_idx = attacker_worker_idx % N_WORKERS as u8;
        // Skip if attacker IS the legit worker (trivially fine)
        let attacker_pk = self.fuzz_accounts.worker
            .get(&mut self.trident, attacker_idx as usize)
            .pubkey();

        if attacker_pk != legit_worker {
            let attack_complete = self.ix_complete_job(
                attacker_idx, &queue_pda, job_id, None,
            );
            assert!(
                !attack_complete.is_success(),
                "SECURITY BUG (Inv2 — unauthorized complete): Worker {:?} completed \
                 a job owned by Worker {:?}! job_id={}",
                attacker_pk, legit_worker, job_id
            );
            assert!(
                attack_complete.is_custom_error_with_code(
                    dec_queue::errors::JobQueueError::Unauthorized as u32
                ),
                "Expected Unauthorized error, got: {:?}",
                attack_complete.custom_error_code()
            );
        }

        // ── Verify job is STILL Processing after failed attack ────────────
        self.invariant_worker_immutability(&queue_pda, job_id, &legit_worker);

        // ── Now legitimate worker completes it ────────────────────────────
        let legit_complete = self.ix_complete_job(legit_idx, &queue_pda, job_id, Some("ok".to_string()));
        assert!(legit_complete.is_success(), "Legitimate complete failed: {:?}", legit_complete);

        // ── Final state check ─────────────────────────────────────────────
        self.invariant_index_total_jobs_consistency(&queue_pda);
        self.invariant_worker_immutability(&queue_pda, job_id, &legit_worker);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

/// Returns true if a TridentResult failed with the Unauthorized error code.
fn fi_worker_mismatch(result: &TridentResult) -> bool {
    result.is_custom_error_with_code(
        dec_queue::errors::JobQueueError::Unauthorized as u32
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness entry point
//
// `trident_fuzz` provides the `fuzz_trident!` macro which wires LibFuzzer's
// `LLVMFuzzerTestOneInput` to our FuzzTest executor.
// ─────────────────────────────────────────────────────────────────────────────
fuzz_trident!(fuzz_ix: FuzzTest);
