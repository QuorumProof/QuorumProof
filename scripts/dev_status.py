#!/usr/bin/env python3
"""scripts/dev_status.py — Development status dashboard generator (#1673).

Collects development health metrics from the local checkout and writes a static
dashboard (HTML) plus the raw data (JSON):

  - Test coverage: line coverage parsed from lcov.info files produced by the
    frontend and dashboard Vitest runs. Compared against the 70% line threshold
    enforced in CI.
  - Performance: compiled size of each Soroban contract (.wasm), since contract
    size is the main performance constraint on Soroban.
  - Repository activity: current branch, last commit, commits in the last 7 days.
  - CI (optional, --ci): the most recent GitHub Actions runs via the `gh` CLI.

Standard library only, so it runs anywhere Python 3 is installed.

Usage:
    python3 scripts/dev_status.py                 # writes reports/dev-status/
    python3 scripts/dev_status.py --ci            # also fetch recent CI runs
    python3 scripts/dev_status.py --output-dir /tmp/status

See docs/dev-status-dashboard.md for the metrics definitions and how to extend them.
"""

from __future__ import annotations

import argparse
import html
import json
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

ROOT = Path(__file__).resolve().parent.parent

# Line-coverage threshold enforced by CI (see frontend/vite.config.ts and .github/workflows/ci.yml).
LINE_COVERAGE_THRESHOLD = 70.0

# lcov files written by the JS test runs. Missing files are reported, not treated as errors.
LCOV_PATHS = {
    "frontend": ROOT / "frontend" / "coverage" / "lcov.info",
    "dashboard": ROOT / "dashboard" / "coverage" / "lcov.info",
}

WASM_DIR = ROOT / "target" / "wasm32-unknown-unknown" / "release"
CONTRACT_NAMES = ("quorum_proof", "sbt_registry", "zk_verifier")


@dataclass
class Coverage:
    name: str
    lines_found: int = 0
    lines_hit: int = 0
    available: bool = False

    @property
    def percent(self) -> Optional[float]:
        if not self.available or self.lines_found == 0:
            return None
        return round(100.0 * self.lines_hit / self.lines_found, 2)

    @property
    def status(self) -> str:
        pct = self.percent
        if pct is None:
            return "no data"
        return "ok" if pct >= LINE_COVERAGE_THRESHOLD else "below threshold"


@dataclass
class ContractSize:
    name: str
    size_bytes: Optional[int]


@dataclass
class Activity:
    branch: str = "unknown"
    last_commit: str = "unknown"
    commits_last_7_days: Optional[int] = None


@dataclass
class CiRun:
    name: str
    branch: str
    status: str
    conclusion: str


@dataclass
class DevStatus:
    generated_at: str
    coverage: list[Coverage] = field(default_factory=list)
    contracts: list[ContractSize] = field(default_factory=list)
    activity: Activity = field(default_factory=Activity)
    ci_runs: Optional[list[CiRun]] = None


# ── Parsers and collectors (pure where possible, so they are unit-tested) ────


def parse_lcov(text: str) -> tuple[int, int]:
    """Return (lines_found, lines_hit) summed over all records in an lcov file.

    lcov records are terminated by `end_of_record`; `LF:` is the number of
    instrumented lines and `LH:` the number of those hit at least once.
    """
    found = hit = 0
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("LF:"):
            found += int(line[3:] or 0)
        elif line.startswith("LH:"):
            hit += int(line[3:] or 0)
    return found, hit


def collect_coverage(paths: dict[str, Path] = LCOV_PATHS) -> list[Coverage]:
    results = []
    for name, path in paths.items():
        cov = Coverage(name=name)
        if path.is_file():
            cov.lines_found, cov.lines_hit = parse_lcov(path.read_text(encoding="utf-8"))
            cov.available = True
        results.append(cov)
    return results


def collect_contract_sizes(wasm_dir: Path = WASM_DIR, names: Iterable[str] = CONTRACT_NAMES) -> list[ContractSize]:
    sizes = []
    for name in names:
        wasm = wasm_dir / f"{name}.wasm"
        sizes.append(ContractSize(name=name, size_bytes=wasm.stat().st_size if wasm.is_file() else None))
    return sizes


def _git(*args: str) -> Optional[str]:
    if shutil.which("git") is None:
        return None
    try:
        out = subprocess.run(
            ["git", *args], cwd=ROOT, capture_output=True, text=True, check=True, timeout=30
        )
    except (subprocess.SubprocessError, OSError):
        return None
    return out.stdout.strip()


def collect_activity() -> Activity:
    activity = Activity()
    activity.branch = _git("rev-parse", "--abbrev-ref", "HEAD") or "unknown"
    activity.last_commit = _git("log", "-1", "--format=%h %s (%cr)") or "unknown"
    recent = _git("rev-list", "--count", "--since=7.days.ago", "HEAD")
    activity.commits_last_7_days = int(recent) if recent and recent.isdigit() else None
    return activity


def collect_ci_runs(limit: int = 5) -> Optional[list[CiRun]]:
    """Fetch recent workflow runs with the gh CLI. Returns None when gh is unavailable."""
    if shutil.which("gh") is None:
        return None
    try:
        out = subprocess.run(
            [
                "gh", "run", "list", "--limit", str(limit),
                "--json", "workflowName,headBranch,status,conclusion",
            ],
            cwd=ROOT, capture_output=True, text=True, check=True, timeout=60,
        )
        rows = json.loads(out.stdout or "[]")
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError):
        return None
    return [
        CiRun(
            name=r.get("workflowName", "?"),
            branch=r.get("headBranch", "?"),
            status=r.get("status", "?"),
            conclusion=r.get("conclusion") or "-",
        )
        for r in rows
    ]


def collect(include_ci: bool) -> DevStatus:
    return DevStatus(
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        coverage=collect_coverage(),
        contracts=collect_contract_sizes(),
        activity=collect_activity(),
        ci_runs=collect_ci_runs() if include_ci else None,
    )


# ── Rendering ────────────────────────────────────────────────────────────────


def format_bytes(size: Optional[int]) -> str:
    if size is None:
        return "not built"
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KiB"
    return f"{size / (1024 * 1024):.2f} MiB"


def _e(value: object) -> str:
    return html.escape(str(value))


def render_html(status: DevStatus) -> str:
    cov_rows = "".join(
        f"<tr><td>{_e(c.name)}</td>"
        f"<td>{'—' if c.percent is None else f'{c.percent:.2f}%'}</td>"
        f"<td>{c.lines_hit}/{c.lines_found}</td>"
        f"<td class=\"{'bad' if c.status == 'below threshold' else ''}\">{_e(c.status)}</td></tr>"
        for c in status.coverage
    )
    contract_rows = "".join(
        f"<tr><td>{_e(c.name)}</td><td>{_e(format_bytes(c.size_bytes))}</td></tr>"
        for c in status.contracts
    )
    if status.ci_runs is None:
        ci_section = "<p class=\"muted\">CI data not collected. Run with <code>--ci</code> and an authenticated <code>gh</code> CLI.</p>"
    elif not status.ci_runs:
        ci_section = "<p class=\"muted\">No recent workflow runs.</p>"
    else:
        rows = "".join(
            f"<tr><td>{_e(r.name)}</td><td>{_e(r.branch)}</td><td>{_e(r.status)}</td><td>{_e(r.conclusion)}</td></tr>"
            for r in status.ci_runs
        )
        ci_section = (
            "<table><thead><tr><th>Workflow</th><th>Branch</th><th>Status</th><th>Conclusion</th></tr></thead>"
            f"<tbody>{rows}</tbody></table>"
        )
    commits = "unknown" if status.activity.commits_last_7_days is None else str(status.activity.commits_last_7_days)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QuorumProof Development Status</title>
<style>
  :root {{ color-scheme: light dark; --fg:#1d1d1f; --bg:#fff; --muted:#6e6e73; --line:#d2d2d7; --bad:#b42318; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --fg:#f5f5f7; --bg:#1c1c1e; --muted:#98989d; --line:#3a3a3c; --bad:#ff6b6b; }} }}
  body {{ margin:0; padding:24px 16px; font:14px/1.5 system-ui,sans-serif; color:var(--fg); background:var(--bg); }}
  main {{ max-width:900px; margin:0 auto; }}
  h1 {{ font-size:22px; margin:0 0 4px; }}
  h2 {{ font-size:16px; margin:28px 0 8px; }}
  table {{ width:100%; border-collapse:collapse; }}
  th,td {{ text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }}
  .bad {{ color:var(--bad); font-weight:600; }}
  .muted {{ color:var(--muted); }}
  .cards {{ display:flex; gap:12px; flex-wrap:wrap; }}
  .card {{ flex:1 1 180px; border:1px solid var(--line); border-radius:8px; padding:12px; }}
  .card b {{ display:block; font-size:20px; }}
  .table-wrap {{ overflow-x:auto; }}
</style>
</head>
<body>
<main>
  <h1>QuorumProof Development Status</h1>
  <p class="muted">Generated {_e(status.generated_at)} · line coverage threshold {LINE_COVERAGE_THRESHOLD:g}%</p>

  <div class="cards">
    <div class="card">Branch<b>{_e(status.activity.branch)}</b></div>
    <div class="card">Commits (7 days)<b>{_e(commits)}</b></div>
    <div class="card">Last commit<b>{_e(status.activity.last_commit)}</b></div>
  </div>

  <h2>Test coverage</h2>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Suite</th><th>Line coverage</th><th>Lines hit</th><th>Status</th></tr></thead>
    <tbody>{cov_rows}</tbody>
  </table>
  </div>
  <p class="muted">Run <code>npm run test:coverage</code> in <code>frontend/</code> or <code>dashboard/</code> to produce lcov data.</p>

  <h2>Contract performance (wasm size)</h2>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Contract</th><th>Size</th></tr></thead>
    <tbody>{contract_rows}</tbody>
  </table>
  </div>
  <p class="muted">Build with <code>cargo build --release --target wasm32-unknown-unknown</code>.</p>

  <h2>Recent CI runs</h2>
  <div class="table-wrap">{ci_section}</div>
</main>
</body>
</html>
"""


def write_outputs(status: DevStatus, output_dir: Path) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "dev-status.json"
    html_path = output_dir / "index.html"
    json_path.write_text(json.dumps(asdict(status), indent=2) + "\n", encoding="utf-8")
    html_path.write_text(render_html(status), encoding="utf-8")
    return html_path, json_path


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--output-dir", type=Path, default=ROOT / "reports" / "dev-status")
    parser.add_argument("--ci", action="store_true", help="also fetch recent CI runs via gh")
    args = parser.parse_args(argv)

    status = collect(include_ci=args.ci)
    html_path, json_path = write_outputs(status, args.output_dir)

    below = [c.name for c in status.coverage if c.status == "below threshold"]
    print(f"Wrote {html_path}")
    print(f"Wrote {json_path}")
    if below:
        print(f"Coverage below {LINE_COVERAGE_THRESHOLD:g}%: {', '.join(below)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
