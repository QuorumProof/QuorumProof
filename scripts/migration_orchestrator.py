#!/usr/bin/env python3
"""
Crash-safe off-chain driver for QuorumProof's chunked migration protocol
(see docs/contract-upgrade-strategy.md#paginated--chunked-migration-protocol).

The orchestrator holds no authoritative state of its own. Every run — including
one that starts because a previous run was killed mid-migration — begins by
asking the chain where the job currently stands (`get_migration_job`) and
drives `migrate_next_chunk` forward from there. There is deliberately no local
checkpoint file, database row, or in-memory cache that could drift from
on-chain truth: if this process dies at any point, the only thing the next
invocation trusts is what it reads back from the contract on its next call.

Usage:
  python3 scripts/migration_orchestrator.py --to-version 2 [--chunk-size 100]

Requires: stellar-sdk  (pip install stellar-sdk)
Env vars:
  STELLAR_RPC_URL        default https://soroban-testnet.stellar.org
  STELLAR_NETWORK        testnet | mainnet | futurenet (default testnet)
  CONTRACT_QUORUM_PROOF  contract id
  STELLAR_SECRET_KEY     admin secret key (S...) — required to submit chunk calls
"""
import argparse
import logging
import os
import sys
import time
from dataclasses import dataclass
from typing import Callable, Optional, Protocol, TypeVar

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("migration_orchestrator")

T = TypeVar("T")


@dataclass(frozen=True)
class MigrationJob:
    id: int
    kind: int
    cursor: int
    total_items: int
    migrated_count: int
    skipped_count: int
    status: str  # "InProgress" | "Completed"
    started_at: int
    updated_at: int
    completed_at: Optional[int]

    @property
    def is_completed(self) -> bool:
        return self.status == "Completed"

    @property
    def progress_ratio(self) -> float:
        if self.total_items == 0:
            return 1.0
        return min(self.cursor - 1, self.total_items) / self.total_items


class ChainClient(Protocol):
    """Everything the orchestrator needs from the chain. Swappable in tests
    for a fake in-memory implementation — see scripts/tests/test_migration_orchestrator.py.
    """

    def start_migration(self, to_version: int) -> MigrationJob: ...

    def migrate_next_chunk(self, migration_id: int, chunk_size: int) -> MigrationJob: ...

    def get_migration_job(self, migration_id: int) -> Optional[MigrationJob]: ...


class RetryExhausted(RuntimeError):
    pass


def with_retry(
    fn: Callable[[], T],
    *,
    max_attempts: int = 5,
    base_delay: float = 1.0,
    max_delay: float = 30.0,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Exponential backoff for transient RPC failures.

    Retrying here is always safe, even if a prior attempt actually landed
    on-chain before the network call reported failure (an ambiguous timeout):
    the next thing this orchestrator does is re-derive its next call from
    fresh on-chain state (the job returned by the call, or a subsequent
    `get_migration_job`), never from an assumption about what the failed
    attempt did.
    """
    attempt = 0
    while True:
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - deliberately broad: retry any transient failure
            attempt += 1
            if attempt >= max_attempts:
                raise RetryExhausted(f"giving up after {attempt} attempts: {exc}") from exc
            delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
            logger.warning("attempt %d failed (%s); retrying in %.1fs", attempt, exc, delay)
            sleep(delay)


def run_migration_to_completion(
    client: ChainClient,
    to_version: int,
    chunk_size: int = 100,
    on_progress: Optional[Callable[[MigrationJob], None]] = None,
    *,
    max_attempts: int = 5,
    base_delay: float = 1.0,
    max_delay: float = 30.0,
    sleep: Callable[[float], None] = time.sleep,
) -> MigrationJob:
    """Drive a chunked migration job to completion.

    Crash-safe by construction: this function reads no state other than what
    `client` returns. Calling it again after a crash — even from a brand new
    process with a brand new `client` instance pointed at the same contract —
    resumes exactly where the chain says the job is, because
    `start_migration` is idempotent (returns the existing job rather than
    resetting it) and `migrate_next_chunk` always continues from whatever
    cursor is currently stored on-chain.

    `max_attempts`/`base_delay`/`max_delay`/`sleep` tune the retry behavior
    around each individual chain call (see `with_retry`) — tests override
    `sleep` with a no-op to exercise many retries without real wall-clock
    delay.
    """
    def call_with_retry(fn):
        return with_retry(fn, max_attempts=max_attempts, base_delay=base_delay, max_delay=max_delay, sleep=sleep)

    job = call_with_retry(lambda: client.start_migration(to_version))
    logger.info(
        "migration %s started/resumed: cursor=%d total=%d status=%s",
        job.id, job.cursor, job.total_items, job.status,
    )

    while not job.is_completed:
        job = call_with_retry(lambda: client.migrate_next_chunk(job.id, chunk_size))
        if on_progress is not None:
            on_progress(job)
        logger.info(
            "migration %s: cursor=%d/%d migrated=%d skipped=%d (%.1f%%)",
            job.id, job.cursor, job.total_items, job.migrated_count,
            job.skipped_count, job.progress_ratio * 100,
        )

    logger.info(
        "migration %s complete: migrated=%d skipped=%d",
        job.id, job.migrated_count, job.skipped_count,
    )
    return job


# ── Real chain client (stellar-sdk) ─────────────────────────────────────────


class StellarChainClient:
    """Submits signed transactions for the admin-gated migration entrypoints
    and simulates the read-only status lookup. Follows the same
    simulate/build/sign/submit/poll pattern as scripts/export_state.py's
    contract-call helpers.
    """

    def __init__(self, rpc_url: str, network_passphrase: str, contract_id: str, admin_secret: str):
        from stellar_sdk import Keypair, SorobanServer

        self.server = SorobanServer(rpc_url)
        self.network_passphrase = network_passphrase
        self.contract_id = contract_id
        self.admin_keypair = Keypair.from_secret(admin_secret)

    def _invoke_signed(self, function_name: str, parameters: list) -> "MigrationJob":
        from stellar_sdk import TransactionBuilder
        from stellar_sdk.soroban_rpc import GetTransactionStatus, SendTransactionStatus

        source = self.server.load_account(self.admin_keypair.public_key)
        tx = (
            TransactionBuilder(source, self.network_passphrase, base_fee=100)
            .append_invoke_contract_function_op(
                contract_id=self.contract_id,
                function_name=function_name,
                parameters=parameters,
            )
            .set_timeout(30)
            .build()
        )
        prepared = self.server.prepare_transaction(tx)
        prepared.sign(self.admin_keypair)
        send_resp = self.server.send_transaction(prepared)
        if send_resp.status == SendTransactionStatus.ERROR:
            raise RuntimeError(f"{function_name} submission rejected: {send_resp.error_result_xdr}")

        # Poll until the network reports a terminal status for this hash.
        for _ in range(30):
            time.sleep(2)
            result = self.server.get_transaction(send_resp.hash)
            if result.status == GetTransactionStatus.SUCCESS:
                return self._decode_job(result)
            if result.status == GetTransactionStatus.FAILED:
                raise RuntimeError(f"{function_name} transaction failed: {result}")
        raise RuntimeError(f"{function_name} did not reach a terminal status in time")

    def _decode_job(self, get_transaction_result) -> "MigrationJob":
        from stellar_sdk import scval

        val = get_transaction_result.return_value
        native = scval.to_native(val)
        return MigrationJob(
            id=int(native["id"]),
            kind=int(native["kind"]),
            cursor=int(native["cursor"]),
            total_items=int(native["total_items"]),
            migrated_count=int(native["migrated_count"]),
            skipped_count=int(native["skipped_count"]),
            status="Completed" if native["status"] == 1 else "InProgress",
            started_at=int(native["started_at"]),
            updated_at=int(native["updated_at"]),
            completed_at=native.get("completed_at"),
        )

    def start_migration(self, to_version: int) -> MigrationJob:
        from stellar_sdk import scval

        return self._invoke_signed(
            "start_metadata_migration",
            [scval.to_address(self.admin_keypair.public_key), scval.to_uint32(to_version)],
        )

    def migrate_next_chunk(self, migration_id: int, chunk_size: int) -> MigrationJob:
        from stellar_sdk import scval

        return self._invoke_signed(
            "migrate_next_chunk",
            [
                scval.to_address(self.admin_keypair.public_key),
                scval.to_uint32(migration_id),
                scval.to_uint32(chunk_size),
            ],
        )

    def get_migration_job(self, migration_id: int) -> Optional[MigrationJob]:
        from stellar_sdk import Account, Keypair, TransactionBuilder, scval

        dummy = Keypair.random()
        account = Account(dummy.public_key, 0)
        tx = (
            TransactionBuilder(account, self.network_passphrase, base_fee=100)
            .append_invoke_contract_function_op(
                contract_id=self.contract_id,
                function_name="get_migration_job",
                parameters=[scval.to_uint32(migration_id)],
            )
            .set_timeout(30)
            .build()
        )
        sim = self.server.simulate_transaction(tx)
        if sim.error or not sim.results:
            return None
        native = scval.to_native(sim.results[0].xdr)
        if native is None:
            return None
        return MigrationJob(
            id=int(native["id"]),
            kind=int(native["kind"]),
            cursor=int(native["cursor"]),
            total_items=int(native["total_items"]),
            migrated_count=int(native["migrated_count"]),
            skipped_count=int(native["skipped_count"]),
            status="Completed" if native["status"] == 1 else "InProgress",
            started_at=int(native["started_at"]),
            updated_at=int(native["updated_at"]),
            completed_at=native.get("completed_at"),
        )


NETWORK_PASSPHRASES = {
    "testnet": "Test SDF Network ; September 2015",
    "mainnet": "Public Global Stellar Network ; September 2015",
    "futurenet": "Test SDF Future Network ; October 2022",
}


def get_env(key: str, default: Optional[str] = None, required: bool = False) -> str:
    val = os.environ.get(key, default)
    if required and not val:
        sys.exit(f"Missing required env var: {key}")
    return val or ""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--to-version", type=int, required=True, help="Target metadata schema version")
    parser.add_argument("--chunk-size", type=int, default=100, help="Items per chunk (server-clamped to 200)")
    args = parser.parse_args()

    rpc_url = get_env("STELLAR_RPC_URL", "https://soroban-testnet.stellar.org")
    network = get_env("STELLAR_NETWORK", "testnet")
    contract_id = get_env("CONTRACT_QUORUM_PROOF", required=True)
    admin_secret = get_env("STELLAR_SECRET_KEY", required=True)

    client = StellarChainClient(
        rpc_url=rpc_url,
        network_passphrase=NETWORK_PASSPHRASES.get(network, NETWORK_PASSPHRASES["testnet"]),
        contract_id=contract_id,
        admin_secret=admin_secret,
    )

    run_migration_to_completion(client, args.to_version, args.chunk_size)


if __name__ == "__main__":
    main()
