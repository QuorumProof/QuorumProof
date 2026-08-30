#!/usr/bin/env python3
# scripts/mutation_history.py — append-only JSONL mutation score history.
#
# Mirrors the pattern in benches/src/history.rs / benches/history/:
#   - One JSONL file under mutants/history/<package>.jsonl
#   - Each line is one CI run: { commit, timestamp, caught, total, score }
#   - Append-only; history is diffable via normal `git log`
#
# Usage:
#   python3 scripts/mutation_history.py append <package> <caught> <total>
#   python3 scripts/mutation_history.py check  <package>
#
#   append — Write a new entry for the current commit.
#   check  — Warn (exit 1) if the latest score regresses more than THRESHOLD
#             below the rolling baseline of the last WINDOW entries.
#
# Environment variables used by append:
#   GITHUB_SHA          (set automatically in GitHub Actions)
#   MUTATION_COMMIT     (override; falls back to `git rev-parse HEAD`)
#
# Issue #1480: Mutation testing results have no trend tracking.

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────────

HISTORY_DIR = Path(__file__).parent.parent / "mutants" / "history"

# Warn when the current score is more than this many percentage points below
# the rolling baseline (0–100 scale).  Deliberately loose — this is meant to
# surface *creep* across many commits, not duplicate the per-run threshold.
REGRESSION_THRESHOLD_PP = 5.0

# Number of prior entries to include in the rolling baseline.
WINDOW = 5


# ── Helpers ────────────────────────────────────────────────────────────────────


def _history_path(package: str) -> Path:
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    return HISTORY_DIR / f"{package}.jsonl"


def _current_commit() -> str:
    sha = os.environ.get("GITHUB_SHA") or os.environ.get("MUTATION_COMMIT")
    if sha:
        return sha[:12]
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], stderr=subprocess.DEVNULL
        )
        return out.decode().strip()
    except Exception:
        return "unknown"


def _load_history(package: str) -> list[dict]:
    path = _history_path(package)
    if not path.exists():
        return []
    entries = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return entries


def _append_entry(package: str, caught: int, total: int) -> dict:
    score = round((caught / total * 100) if total > 0 else 0.0, 2)
    entry = {
        "commit": _current_commit(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "package": package,
        "caught": caught,
        "total": total,
        "score": score,
    }
    path = _history_path(package)
    with path.open("a") as fh:
        fh.write(json.dumps(entry) + "\n")
    return entry


def _rolling_baseline(history: list[dict]) -> float | None:
    """Mean score of up to the last WINDOW entries."""
    if not history:
        return None
    window = [e["score"] for e in history[-WINDOW:]]
    return sum(window) / len(window)


# ── Sub-commands ───────────────────────────────────────────────────────────────


def cmd_append(package: str, caught: int, total: int) -> None:
    entry = _append_entry(package, caught, total)
    print(
        f"[mutation_history] appended: {package} "
        f"caught={caught}/{total} score={entry['score']}% "
        f"commit={entry['commit']}"
    )


def cmd_check(package: str) -> None:
    history = _load_history(package)
    if len(history) < 2:
        print(
            f"[mutation_history] {package}: fewer than 2 history entries, "
            "skipping regression check"
        )
        return

    # The last entry is the current run (just appended by cmd_append).
    current = history[-1]
    baseline_history = history[:-1]
    baseline = _rolling_baseline(baseline_history)

    if baseline is None:
        return

    delta = current["score"] - baseline
    print(
        f"[mutation_history] {package}: "
        f"current={current['score']}%  "
        f"baseline={baseline:.2f}%  "
        f"delta={delta:+.2f}pp"
    )

    if delta < -REGRESSION_THRESHOLD_PP:
        print(
            f"[mutation_history] WARNING: mutation score for {package} "
            f"dropped {abs(delta):.2f}pp below rolling baseline "
            f"({baseline:.2f}% → {current['score']}%).  "
            "Add tests to cover the newly missed mutants.",
            file=sys.stderr,
        )
        sys.exit(1)
    else:
        print(f"[mutation_history] {package}: score within acceptable range ✓")


# ── Entry point ────────────────────────────────────────────────────────────────


def main() -> None:
    if len(sys.argv) < 3:
        print(
            "Usage:\n"
            "  mutation_history.py append <package> <caught> <total>\n"
            "  mutation_history.py check  <package>\n",
            file=sys.stderr,
        )
        sys.exit(2)

    sub = sys.argv[1]
    package = sys.argv[2]

    if sub == "append":
        if len(sys.argv) != 5:
            print("append requires: <package> <caught> <total>", file=sys.stderr)
            sys.exit(2)
        caught = int(sys.argv[3])
        total = int(sys.argv[4])
        cmd_append(package, caught, total)

    elif sub == "check":
        cmd_check(package)

    else:
        print(f"Unknown sub-command: {sub}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
