//! fuzz_accounts.rs — Persistent account address store
//!
//! Trident's `FuzzAccounts` stores on-chain addresses that survive across
//! transactions within a single fuzzing *iteration*.  The fuzzer generates
//! an `Arbitrary` keypair index; `FuzzAccounts` resolves it to a stable
//! `Pubkey` so instructions that reference the same account across a flow
//! always get the same key.
//!
//! # Why this matters for DecQueue
//! Each queue, queue_head, and job PDA is derived deterministically from
//! (authority, name) or (queue_pubkey, job_id).  If Trident picked a random
//! Pubkey for "the queue" in every instruction, the program would always fail
//! with ConstraintSeeds.  By pinning those addresses here we get meaningful
//! state transitions across a full enqueue→claim→complete lifecycle.

use trident_fuzz::prelude::*;

/// All unique signer / account "slots" the fuzzer can pick from.
///
/// Index-based selection: the fuzzer picks a `u8` index; `get()` turns that
/// into a stable `Keypair` (and derived `Pubkey`).  Small max values keep
/// the address space tractable for the fuzzer to explore.
pub struct FuzzAccounts {
    /// Queue authorities / producers (up to 4 distinct authorities)
    pub authority: AccountsStorage<KeypairStore>,

    /// Workers (up to 8 distinct workers racing for jobs)
    pub worker: AccountsStorage<KeypairStore>,

    /// Queue PDA addresses — derived, not signers
    /// Stored as PdaStore so the fuzzer can reference them by index.
    pub queue: AccountsStorage<PdaStore>,

    /// QueueHead PDA for each queue slot
    pub queue_head: AccountsStorage<PdaStore>,

    /// JobIndex page PDAs (page seq 0..4)
    pub index_page: AccountsStorage<PdaStore>,

    /// Job PDAs — one slot per possible job_id (0..16)
    pub job: AccountsStorage<PdaStore>,
}
