# Scheduled Contract Upgrades

`QuorumProofContract::upgrade` has always required an admin to submit the
upgrade transaction at the exact moment it should happen — there was no way to
plan a maintenance window in advance and let the upgrade land unattended.
This document covers the scheduling layer added on top of it in
`contracts/quorum_proof/src/upgrade_schedule.rs`.

For breaking-change classification and the general upgrade mechanism, see
[contract-upgrade-guide.md](./contract-upgrade-guide.md) and
[contract-upgrade-strategy.md](./contract-upgrade-strategy.md) — those still
apply in full; this only changes *when* `env.deployer().update_current_contract_wasm`
gets called, not what's safe to put in the new WASM.

## Contract methods

| Method | Auth | Effect |
|---|---|---|
| `schedule_upgrade(admin, new_wasm_hash, execution_time)` | Admin only | Stores a pending upgrade. Overwrites any existing schedule — there is only one pending slot. Panics if `new_wasm_hash` is blank or `execution_time` is not in the future. Emits `UpgradeScheduled`. |
| `cancel_scheduled_upgrade(admin)` | Admin only | Clears the pending schedule. No-op if none exists. Emits `UpgradeScheduleCancelled`. |
| `get_scheduled_upgrade()` | None (read-only) | Returns the pending `ScheduledUpgrade { new_wasm_hash, execution_time, scheduled_at, notified }`, or `None`. |
| `execute_scheduled_upgrade()` | None | If `execution_time` has been reached, applies the upgrade via `env.deployer().update_current_contract_wasm` and clears the schedule. No-op (returns `None`, storage untouched) if nothing is scheduled or the time hasn't arrived yet. Emits `ScheduledUpgradeExecuted`. |
| `check_upgrade_notification()` | None | If a schedule exists, isn't yet notified, and is within `NOTICE_WINDOW_SECONDS` (1 hour) of `execution_time`, marks it notified and emits `UpgradeImminent`. Otherwise a no-op. |

`execute_scheduled_upgrade` and `check_upgrade_notification` are intentionally
permissionless: the admin already authorized *what* to upgrade to and *when*
at schedule time, so the actual time-gated trigger doesn't need further
authorization. This is what lets an unattended off-chain relayer drive both
calls on a timer without holding admin keys.

## Why one pending slot, not a queue

Soroban has no native scheduler, so "execution" always means an external actor
calling in at or after `execution_time`. Supporting multiple queued upgrades
would mean reasoning about which one applies if two windows overlap, with no
extra benefit — an admin who needs to change the plan just calls
`schedule_upgrade` again (or `cancel_scheduled_upgrade`) before the window
opens. This mirrors `upgrade`'s existing single-target semantics.

## Off-chain relayer

Because execution is time-gated but not self-triggering, something has to
call `execute_scheduled_upgrade` and `check_upgrade_notification`
periodically. `scripts/upgrade_scheduler.py` is a small polling loop intended
to run as a cron job or long-lived process:

```bash
export STELLAR_RPC_URL=https://soroban-testnet.stellar.org
export CONTRACT_QUORUM_PROOF=C...
export STELLAR_SECRET_KEY=S...        # any funded key; no admin rights needed
export POLL_INTERVAL_SECONDS=60
python3 scripts/upgrade_scheduler.py
```

Each poll:

1. Calls `check_upgrade_notification()` — if it returns `true`, the relayer
   also posts to `NOTIFY_WEBHOOK` (if configured) so operators get a
   human-readable heads-up alongside the on-chain `UpgradeImminent` event.
2. Calls `execute_scheduled_upgrade()` — if it returns a WASM hash (not
   `None`), the upgrade just happened; the relayer logs it and exits (no
   schedule left to poll for).

## Scheduling an upgrade

```bash
stellar contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --source admin \
  --network testnet \
  -- schedule_upgrade \
    --admin "$(stellar keys address admin)" \
    --new_wasm_hash <hex-hash-of-new-wasm> \
    --execution_time <unix-timestamp>
```

Pick `execution_time` far enough out that `scripts/upgrade_scheduler.py` (or
equivalent) has at least one poll interval inside the `NOTICE_WINDOW_SECONDS`
window before it, so the imminent-upgrade notification actually has time to
reach anyone before downtime starts.
