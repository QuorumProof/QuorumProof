#!/usr/bin/env python3
"""Off-chain relayer for scheduled contract upgrades.

Soroban has no native scheduler, so a scheduled upgrade
(`schedule_upgrade(admin, new_wasm_hash, execution_time)`, see
docs/scheduled-upgrades.md) still needs something external polling the
contract to trigger `check_upgrade_notification()` (pre-upgrade warning) and
`execute_scheduled_upgrade()` (the actual cutover) once `execution_time`
arrives. This script is that something — run it as a cron job or a long-lived
process alongside the monitoring exporter.

Both calls this script drives are permissionless: the admin already
authorized the target WASM hash and time at `schedule_upgrade`, so this
relayer needs no admin key, only a funded account to submit transactions.
"""

import os
import sys
import time
import logging

import requests

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("upgrade_scheduler")


def notify(webhook: str, message: str) -> None:
    logger.info("NOTIFY: %s", message)
    if not webhook:
        return
    try:
        requests.post(webhook, json={"text": f"[QuorumProof] {message}"}, timeout=10)
    except Exception as exc:  # notification failures must never crash the relayer
        logger.error("Failed to post notification: %s", exc)


def invoke(contract_id: str, source: str, network: str, function: str) -> bool:
    """Invoke a permissionless contract function via the Stellar CLI.

    Returns True if the call succeeded and returned a non-null/non-false
    result (i.e. "something happened"), False otherwise. Any invocation
    failure is treated as "nothing to do yet" rather than a fatal error, since
    both functions this relayer calls are safe, idempotent no-ops when there
    is nothing pending.
    """
    import subprocess

    result = subprocess.run(
        [
            "stellar", "contract", "invoke",
            "--id", contract_id,
            "--source", source,
            "--network", network,
            "--", function,
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        logger.debug("%s returned non-zero: %s", function, result.stderr.strip())
        return False
    output = result.stdout.strip()
    return output not in ("", "null", "false")


def poll_once(contract_id: str, source: str, network: str, webhook: str) -> bool:
    """Run one notification + execution check. Returns True if the upgrade
    was executed this poll (caller should stop polling)."""
    if invoke(contract_id, source, network, "check_upgrade_notification"):
        notify(
            webhook,
            f"Scheduled upgrade for {contract_id} is imminent "
            f"(within the notice window). Expect downtime soon.",
        )

    if invoke(contract_id, source, network, "execute_scheduled_upgrade"):
        notify(webhook, f"Scheduled upgrade for {contract_id} has been executed.")
        return True

    return False


def main() -> None:
    contract_id = os.getenv("CONTRACT_QUORUM_PROOF")
    if not contract_id:
        logger.error("CONTRACT_QUORUM_PROOF environment variable not set")
        sys.exit(1)

    network = os.getenv("STELLAR_NETWORK", "testnet")
    source = os.getenv("STELLAR_RELAYER_IDENTITY", "upgrade_relayer")
    webhook = os.getenv("NOTIFY_WEBHOOK", "")
    poll_interval = int(os.getenv("POLL_INTERVAL_SECONDS", "60"))
    run_once = os.getenv("RUN_ONCE", "").lower() in ("1", "true", "yes")

    logger.info(
        "Starting upgrade scheduler: contract=%s network=%s interval=%ss",
        contract_id, network, poll_interval,
    )

    while True:
        try:
            executed = poll_once(contract_id, source, network, webhook)
        except Exception as exc:
            logger.error("Poll failed: %s", exc)
            executed = False

        if executed or run_once:
            break

        time.sleep(poll_interval)


if __name__ == "__main__":
    main()
