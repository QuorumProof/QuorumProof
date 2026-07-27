# Disaster Recovery Plan — Implementation Notes

This note summarizes what changed in `docs/disaster-recovery.md` to close out
the DR planning issue. It exists because the code/doc diff for this issue is
small relative to the size of the underlying plan — most of the DR content
(failover procedures, state recovery, RTO/RPO tables, and per-scenario
recovery drills) already existed in that document. What was added here is
specifically the pieces that were missing.

## What was already in place before this change

- Failover procedures for admin key loss, contract redeployment, RPC outage,
  interrupted migrations, frontend outage, API server compromise, contract
  bugs, and search-index corruption (`disaster-recovery.md` §1).
- Backup strategy and automated state snapshots (§2).
- Recovery Time Objectives / Recovery Point Objectives per scenario (§2.3).
- A step-by-step recovery runbook (§3).
- Recovery testing drills — key recovery, redeployment, snapshot/restore,
  RPC failover, emergency pause, API secret rotation — all already run on a
  defined cadence, several already quarterly (§4).

## What this change adds

1. **§5 Roles & Responsibilities** — a named-role table (Incident Commander,
   Chain/Contract Lead, Infra Lead, Data/Recovery Lead, Communications Lead,
   Scribe) so a DR event doesn't stall on "who does this," plus an escalation
   path describing how the Incident Commander role is assigned and handed off.
2. **§6 Communication Plan** — internal and external communication tables
   (audience, channel, cadence, owner), message-content guidelines, and a
   post-incident communication step, since the existing doc had no dedicated
   communication section.
3. **§7 DR Testing Schedule Summary** — a single consolidated table pulling
   together the drill cadences already defined in §4, plus a new quarterly
   full-team tabletop exercise that exercises the new §5/§6 roles and
   communication plan end-to-end, not just the technical recovery steps.

## Why extend the existing doc instead of writing a new one

The existing `docs/disaster-recovery.md` already covered the technical
recovery procedures and RTO/RPO in detail. Splitting roles/communication into
a separate file would have forced readers to cross-reference two documents
during an actual incident; keeping it as one document with clearly numbered
sections was the lower-risk choice for something meant to be read under
pressure.
