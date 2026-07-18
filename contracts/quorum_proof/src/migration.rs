//! Generic paginated/chunked migration engine.
//!
//! Soroban enforces a hard per-invocation CPU/memory ceiling, so a migration that
//! touches every stored record cannot run as a single transaction once a deployment
//! has accumulated more than a few hundred records. This module provides a small,
//! reusable state machine — a `MigrationJob` with an on-chain cursor — that any
//! concrete migration (metadata schema upgrades today; future migrations of Slice
//! or SBT records can reuse the same primitives) drives forward one bounded chunk
//! per transaction.
//!
//! Design invariants that make this safe to drive from a crash-prone off-chain
//! orchestrator, without any off-chain state being authoritative:
//!
//! 1. **The cursor lives on-chain, not in the orchestrator.** Every chunk call reads
//!    its start position from contract storage, never from a caller-supplied
//!    argument. A restarted (or duplicated) orchestrator process that resubmits a
//!    chunk call cannot "rewind" progress or double-process a range: whatever it
//!    sends, the contract only ever advances from wherever storage currently says
//!    the job is.
//! 2. **Per-item work is itself idempotent.** The concrete migration functions that
//!    call into this engine (see `QuorumProofContract::migrate_next_chunk`) check
//!    each item's own version/state marker before transforming it, so even if the
//!    same on-chain range were somehow processed twice, re-applying the transform
//!    to an already-migrated item is a no-op.
//! 3. **A completed job is a permanent no-op.** Once `status` flips to `Completed`,
//!    every further call against that job id returns immediately without touching
//!    storage.
//!
//! Reads of migration status are unauthenticated and always available — the
//! monitoring stack and the orchestrator poll `get_job` the same way regardless of
//! whether a migration is running.

use soroban_sdk::{contracttype, Env};

use crate::{EXTENDED_TTL, STANDARD_TTL};

/// Maximum number of items a single `migrate_next_chunk` invocation may touch,
/// regardless of what the caller requests. This is the safety valve against
/// Soroban's per-invocation CPU/memory ceiling: no matter how an orchestrator is
/// configured, one transaction can never be asked to walk more than this many
/// storage entries.
pub const MAX_CHUNK_SIZE: u32 = 200;

#[contracttype]
#[derive(Clone)]
pub enum DataKeyMigration {
    /// A migration job, keyed by an admin-chosen id (by convention, the target
    /// schema/format version for schema-upgrade style migrations).
    Job(u32),
}

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum MigrationStatus {
    InProgress = 0,
    Completed = 1,
}

/// Progress record for one chunked migration run.
#[contracttype]
#[derive(Clone, Debug)]
pub struct MigrationJob {
    pub id: u32,
    /// Identifies which concrete migration this job drives (e.g. 1 =
    /// credential-metadata-schema upgrade). Lets the engine be reused for future
    /// migration kinds without a new storage layout.
    pub kind: u32,
    /// Next item id to examine. Starts at 1; once it exceeds `total_items` the job
    /// is complete. This is the authoritative on-chain progress cursor.
    pub cursor: u64,
    /// Snapshot of the item count taken when the job was created. Items created
    /// after the snapshot are expected to already be written at the target
    /// state/version by the write path itself, so they are correctly excluded.
    pub total_items: u64,
    pub migrated_count: u64,
    pub skipped_count: u64,
    pub status: MigrationStatus,
    pub started_at: u64,
    pub updated_at: u64,
    pub completed_at: Option<u64>,
}

impl MigrationJob {
    pub fn is_completed(&self) -> bool {
        self.status == MigrationStatus::Completed
    }

    /// Percentage of `total_items` examined so far, in basis points (0..=10_000),
    /// avoiding floating point in contract code. Returns 10_000 for a zero-item job
    /// (nothing to do => immediately 100% done).
    pub fn progress_bps(&self) -> u32 {
        if self.total_items == 0 {
            return 10_000;
        }
        let examined = core::cmp::min(self.cursor.saturating_sub(1), self.total_items);
        ((examined * 10_000) / self.total_items) as u32
    }
}

pub fn get_job(env: &Env, id: u32) -> Option<MigrationJob> {
    env.storage().instance().get(&DataKeyMigration::Job(id))
}

fn set_job(env: &Env, job: &MigrationJob) {
    env.storage().instance().set(&DataKeyMigration::Job(job.id), job);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
}

/// Create a job for `id` if none exists yet; otherwise return the existing job
/// untouched. Idempotent by construction — an orchestrator that crashed before
/// observing the result of its first "start" call can call this again on restart
/// without resetting progress or losing the original `total_items` snapshot.
pub fn start_job(env: &Env, id: u32, kind: u32, total_items: u64) -> MigrationJob {
    if let Some(existing) = get_job(env, id) {
        return existing;
    }
    let now = env.ledger().timestamp();
    let job = MigrationJob {
        id,
        kind,
        cursor: 1,
        total_items,
        migrated_count: 0,
        skipped_count: 0,
        status: if total_items == 0 {
            MigrationStatus::Completed
        } else {
            MigrationStatus::InProgress
        },
        started_at: now,
        updated_at: now,
        completed_at: if total_items == 0 { Some(now) } else { None },
    };
    set_job(env, &job);
    job
}

/// Clamp a caller-requested chunk size into `1..=MAX_CHUNK_SIZE`.
pub fn clamp_chunk_size(requested: u32) -> u32 {
    if requested == 0 || requested > MAX_CHUNK_SIZE {
        MAX_CHUNK_SIZE
    } else {
        requested
    }
}

/// Persist the outcome of processing `[job.cursor, job.cursor + items_examined)`.
/// Flips the job to `Completed` once the cursor passes `total_items`. Called at
/// most once per `migrate_next_chunk` invocation, after the chunk's storage writes
/// have already succeeded — so a chunk either fully lands (items transformed AND
/// cursor advanced) or, if the transaction panics/fails partway, nothing lands at
/// all (Soroban reverts the whole invocation). There is no state in between.
pub fn advance(env: &Env, mut job: MigrationJob, items_examined: u64, migrated: u64, skipped: u64) -> MigrationJob {
    job.cursor += items_examined;
    job.migrated_count += migrated;
    job.skipped_count += skipped;
    job.updated_at = env.ledger().timestamp();
    if job.cursor > job.total_items {
        job.status = MigrationStatus::Completed;
        job.completed_at = Some(job.updated_at);
    }
    set_job(env, &job);
    job
}
