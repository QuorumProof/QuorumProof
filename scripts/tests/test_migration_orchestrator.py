#!/usr/bin/env python3
"""
Tests for scripts/migration_orchestrator.py.

The key property under test: the orchestrator is crash-safe because it treats
on-chain state as the only source of truth. `FakeChainState` below plays the
role of the contract (mirroring contracts/quorum_proof/src/migration.rs's
cursor semantics exactly: start_job is idempotent, migrate_next_chunk always
resumes from the currently-stored cursor regardless of what the caller
assumes). `CrashyClientView` plays the role of one orchestrator process's view
of the chain, and can be made to "die" — raise instead of returning — after a
configured number of calls, without corrupting the shared on-chain state. A
fresh `CrashyClientView` over the same `FakeChainState` then models a restarted
process, and the test asserts the migration completes correctly with no id
skipped or migrated twice.

Run with: python3 -m unittest scripts/tests/test_migration_orchestrator.py
"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from migration_orchestrator import (  # noqa: E402
    MigrationJob,
    RetryExhausted,
    run_migration_to_completion,
    with_retry,
)

MAX_CHUNK_SIZE = 200  # mirrors migration::MAX_CHUNK_SIZE in the Rust engine


class FakeChainState:
    """Persistent on-chain state shared across (possibly many) client views,
    exactly like a real ledger persists across orchestrator restarts.
    """

    def __init__(self, total_items: int):
        self.total_items = total_items
        self.jobs: dict[int, dict] = {}
        # Tracks how many times each item id was actually transformed, so a
        # test can assert "never migrated twice" independent of the job
        # bookkeeping itself.
        self.item_migration_counts: dict[int, int] = {i: 0 for i in range(1, total_items + 1)}
        self.next_chunk_calls = 0

    def start_job(self, job_id: int, kind: int, total_items: int, now: int) -> dict:
        if job_id in self.jobs:
            return dict(self.jobs[job_id])
        job = {
            "id": job_id, "kind": kind, "cursor": 1, "total_items": total_items,
            "migrated_count": 0, "skipped_count": 0,
            "status": "Completed" if total_items == 0 else "InProgress",
            "started_at": now, "updated_at": now,
            "completed_at": now if total_items == 0 else None,
        }
        self.jobs[job_id] = job
        return dict(job)

    def next_chunk(self, job_id: int, chunk_size: int, now: int) -> dict:
        self.next_chunk_calls += 1
        job = self.jobs[job_id]
        if job["status"] == "Completed":
            return dict(job)  # idempotent no-op, mirrors the contract

        size = min(chunk_size, MAX_CHUNK_SIZE) or MAX_CHUNK_SIZE
        start_id = job["cursor"]
        end_id = min(start_id + size - 1, job["total_items"])

        migrated = 0
        for item_id in range(start_id, end_id + 1):
            self.item_migration_counts[item_id] += 1
            migrated += 1

        examined = max(end_id - start_id + 1, 0) if end_id >= start_id else 0
        job["cursor"] += examined
        job["migrated_count"] += migrated
        job["updated_at"] = now
        if job["cursor"] > job["total_items"]:
            job["status"] = "Completed"
            job["completed_at"] = now
        return dict(job)

    def get_job(self, job_id: int) -> "dict | None":
        job = self.jobs.get(job_id)
        return dict(job) if job else None


def _job_from_dict(d: dict) -> MigrationJob:
    return MigrationJob(**d)


class CrashyClientView:
    """One orchestrator process's view of `FakeChainState`. `fail_after`
    calls (across start_migration + migrate_next_chunk combined) succeed
    normally; the next call raises, simulating the process being killed
    (e.g. by an OOM or a deploy) partway through a chunk submission — before
    the orchestrator's loop can do anything else. The already-applied on-chain
    state (`state`) is untouched by this failure; only this view "dies".
    """

    def __init__(self, state: FakeChainState, fail_after: "int | None" = None):
        self.state = state
        self.fail_after = fail_after
        self.calls = 0
        self._now = 1_000

    def _tick(self):
        self.calls += 1
        if self.fail_after is not None and self.calls > self.fail_after:
            raise ConnectionError("simulated crash: process killed mid-call")
        self._now += 1

    def start_migration(self, to_version: int) -> MigrationJob:
        self._tick()
        return _job_from_dict(self.state.start_job(to_version, to_version, self.state.total_items, self._now))

    def migrate_next_chunk(self, migration_id: int, chunk_size: int) -> MigrationJob:
        self._tick()
        return _job_from_dict(self.state.next_chunk(migration_id, chunk_size, self._now))

    def get_migration_job(self, migration_id: int):
        job = self.state.get_job(migration_id)
        return _job_from_dict(job) if job else None


class TestWithRetry(unittest.TestCase):
    def test_succeeds_without_retry(self):
        self.assertEqual(with_retry(lambda: 42, sleep=lambda _: None), 42)

    def test_retries_then_succeeds(self):
        attempts = {"n": 0}

        def flaky():
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise TimeoutError("transient")
            return "ok"

        result = with_retry(flaky, max_attempts=5, base_delay=0.0, sleep=lambda _: None)
        self.assertEqual(result, "ok")
        self.assertEqual(attempts["n"], 3)

    def test_gives_up_after_max_attempts(self):
        def always_fails():
            raise TimeoutError("nope")

        with self.assertRaises(RetryExhausted):
            with_retry(always_fails, max_attempts=3, base_delay=0.0, sleep=lambda _: None)


def run_fast(client, **kwargs) -> MigrationJob:
    """run_migration_to_completion with retry knobs tuned for instant,
    deterministic tests instead of real wall-clock backoff delays.
    """
    return run_migration_to_completion(
        client, max_attempts=2, base_delay=0.0, max_delay=0.0, sleep=lambda _: None, **kwargs,
    )


class TestMigrationOrchestrator(unittest.TestCase):
    def test_completes_full_migration_without_a_crash(self):
        state = FakeChainState(total_items=950)
        client = CrashyClientView(state)

        job = run_fast(client, to_version=2, chunk_size=100)

        self.assertTrue(job.is_completed)
        self.assertEqual(job.migrated_count, 950)
        self.assertEqual(job.cursor, 951)
        self.assertTrue(all(c == 1 for c in state.item_migration_counts.values()))

    def test_kill_and_restart_completes_with_no_duplication_or_loss(self):
        """The central proof: a process that dies partway through, followed
        by a completely fresh process/client resuming, must migrate every
        item exactly once — never zero times (data loss), never more than
        once (duplication).
        """
        state = FakeChainState(total_items=1_000)

        # "Process A": crashes after 3 successful chain calls (1 start +
        # 2 chunk submissions of size 100 => items 1..200 genuinely landed
        # on-chain before the process died).
        process_a = CrashyClientView(state, fail_after=3)
        with self.assertRaises(RetryExhausted):
            run_fast(
                process_a, to_version=2, chunk_size=100,
            )

        job_after_crash = state.get_job(2)
        self.assertEqual(job_after_crash["status"], "InProgress")
        self.assertEqual(job_after_crash["cursor"], 201, "the first 2 chunks must have landed before the crash")

        # "Process B": brand new client instance, no memory of process A's
        # local state, pointed at the same on-chain job id.
        process_b = CrashyClientView(state)
        final_job = run_fast(process_b, to_version=2, chunk_size=100)

        self.assertTrue(final_job.is_completed)
        self.assertEqual(final_job.cursor, 1_001)
        self.assertEqual(final_job.migrated_count, 1_000, "every item must be migrated exactly once in total")
        self.assertEqual(
            list(state.item_migration_counts.values()),
            [1] * 1_000,
            "no item may be migrated zero times (data loss) or more than once (duplication)",
        )

    def test_repeated_crash_and_restart_cycles_still_converge(self):
        """A harsher version: each 'process' only gets to complete exactly one
        successful chunk call before dying, so reaching completion genuinely
        requires many restart cycles — still converges with no duplication.
        """
        state = FakeChainState(total_items=430)
        remaining_processes = 20  # generous upper bound so a stuck loop fails loudly instead of hanging
        job = None
        while remaining_processes > 0:
            remaining_processes -= 1
            # fail_after=2 => 1 start_migration call + 1 migrate_next_chunk
            # call succeed, then this "process" dies on its next call.
            process = CrashyClientView(state, fail_after=2)
            try:
                job = run_fast(process, to_version=2, chunk_size=50)
                break  # completed without hitting the injected failure
            except RetryExhausted:
                continue  # "process" died; loop simulates an operator/systemd restart

        self.assertIsNotNone(job, "migration must eventually converge across restarts")
        self.assertTrue(job.is_completed)
        self.assertEqual(job.migrated_count, 430)
        self.assertEqual(list(state.item_migration_counts.values()), [1] * 430)

    def test_restarting_after_full_completion_is_a_noop(self):
        state = FakeChainState(total_items=50)
        client = CrashyClientView(state)
        run_fast(client, to_version=2, chunk_size=100)

        calls_before = state.next_chunk_calls
        # A restarted orchestrator that doesn't know the job already finished
        # just runs again unconditionally.
        job = run_fast(CrashyClientView(state), to_version=2, chunk_size=100)
        self.assertTrue(job.is_completed)
        self.assertEqual(job.migrated_count, 50)
        # It should have made exactly one additional next_chunk call (which
        # immediately saw Completed and returned) plus one start call, not
        # re-walked the dataset.
        self.assertLessEqual(state.next_chunk_calls - calls_before, 1)

    def test_zero_item_migration_completes_immediately(self):
        state = FakeChainState(total_items=0)
        client = CrashyClientView(state)
        job = run_fast(client, to_version=2, chunk_size=100)
        self.assertTrue(job.is_completed)
        self.assertEqual(job.total_items, 0)


if __name__ == "__main__":
    unittest.main()
