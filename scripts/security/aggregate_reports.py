#!/usr/bin/env python3
"""
Issue #1631: Aggregate security scanner output into a single report.

Walks a directory of scanner artifacts produced by .github/workflows/security.yml
and normalises every finding into one schema:

    {tool, category, severity, id, title, location}

Supported inputs (detected by file name / content):

  * *.sarif               SAST (Semgrep, CodeQL, Clippy), Trivy (fs/config/image)
  * cargo-audit*.json     `cargo audit --json`
  * npm-audit-*.json      `npm audit --json` (npm >= 7 format)
  * cargo-deny*.txt       `cargo deny check` output (errors counted, not itemised)

Outputs a Markdown summary (suitable for $GITHUB_STEP_SUMMARY / PR comment) and a
JSON report. Exits non-zero when any finding is at or above --fail-on.

Usage:
    python3 scripts/security/aggregate_reports.py reports/ \
        --markdown security-report.md --json security-report.json --fail-on high
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict

SEVERITIES = ["critical", "high", "medium", "low", "info"]
RANK = {s: i for i, s in enumerate(SEVERITIES)}

CATEGORY_BY_TOOL = {
    "semgrep": "SAST",
    "codeql": "SAST",
    "clippy": "SAST",
    "trivy": "Container / IaC",
    "cargo-audit": "Dependencies",
    "cargo-deny": "Dependencies",
    "npm-audit": "Dependencies",
}


def norm_sev(value) -> str:
    if value is None:
        return "info"
    if isinstance(value, (int, float)):
        # CVSS-style score (used by CodeQL `security-severity`)
        v = float(value)
        return "critical" if v >= 9 else "high" if v >= 7 else "medium" if v >= 4 else "low" if v > 0 else "info"
    v = str(value).strip().lower()
    try:
        return norm_sev(float(v))
    except ValueError:
        pass
    return {
        "error": "high",
        "warning": "medium",
        "note": "low",
        "none": "info",
        "moderate": "medium",
        "unknown": "info",
        "negligible": "low",
    }.get(v, v if v in RANK else "info")


def finding(tool, severity, id_, title, location=""):
    return {
        "tool": tool,
        "category": CATEGORY_BY_TOOL.get(tool, "Other"),
        "severity": norm_sev(severity),
        "id": str(id_),
        "title": (title or "").strip().splitlines()[0][:200] if title else "",
        "location": location,
    }


def tool_from_sarif(run: dict, path: str) -> str:
    name = run.get("tool", {}).get("driver", {}).get("name", "").lower()
    for known in ("semgrep", "codeql", "clippy", "trivy"):
        if known in name or known in os.path.basename(path).lower():
            return known
    return name or "sarif"


def parse_sarif(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    out = []
    for run in data.get("runs", []):
        tool = tool_from_sarif(run, path)
        rules = {}
        for r in run.get("tool", {}).get("driver", {}).get("rules", []) or []:
            rules[r.get("id")] = r
        for res in run.get("results", []) or []:
            rule = rules.get(res.get("ruleId"), {})
            props = rule.get("properties", {}) or {}
            sev = props.get("security-severity")
            if sev is None:
                tags = [t.lower() for t in props.get("tags", []) or []]
                sev = next((t for t in tags if t in RANK), None)
            if sev is None:
                sev = res.get("level") or rule.get("defaultConfiguration", {}).get("level")
            loc = ""
            locs = res.get("locations") or []
            if locs:
                pl = locs[0].get("physicalLocation", {})
                uri = pl.get("artifactLocation", {}).get("uri", "")
                line = pl.get("region", {}).get("startLine")
                loc = f"{uri}:{line}" if line else uri
            title = res.get("message", {}).get("text") or rule.get("shortDescription", {}).get("text")
            out.append(finding(tool, sev, res.get("ruleId", "?"), title, loc))
    return out


def parse_cargo_audit(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    out = []
    for v in data.get("vulnerabilities", {}).get("list", []) or []:
        adv = v.get("advisory", {})
        pkg = v.get("package", {})
        sev = adv.get("cvss") and cvss_to_sev(adv["cvss"]) or "high"
        out.append(finding("cargo-audit", sev, adv.get("id"), adv.get("title"), f"{pkg.get('name')}@{pkg.get('version')}"))
    for kind, items in (data.get("warnings") or {}).items():
        for w in items or []:
            adv = w.get("advisory") or {}
            pkg = w.get("package", {})
            out.append(
                finding("cargo-audit", "low", adv.get("id", kind), adv.get("title", kind), f"{pkg.get('name')}@{pkg.get('version')}")
            )
    return out


def cvss_to_sev(vector: str) -> str:
    # cargo-audit gives a CVSS vector, not a score. Approximate from impact metrics.
    high_impact = sum(1 for m in ("C:H", "I:H", "A:H") if m in vector)
    network = "AV:N" in vector
    if high_impact >= 2 and network:
        return "critical"
    if high_impact >= 1:
        return "high"
    if any(m in vector for m in ("C:L", "I:L", "A:L")):
        return "medium"
    return "low"


def parse_npm_audit(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        try:
            data = json.load(fh)
        except json.JSONDecodeError:
            return []
    project = re.sub(r"^npm-audit-|\.json$", "", os.path.basename(path))
    out = []
    for name, v in (data.get("vulnerabilities") or {}).items():
        advisories = [x for x in v.get("via", []) if isinstance(x, dict)]
        if not advisories:
            continue  # transitive-only entry; the root advisory is reported on its own package
        for adv in advisories:
            out.append(
                finding(
                    "npm-audit",
                    adv.get("severity", v.get("severity")),
                    adv.get("url", adv.get("source", name)),
                    adv.get("title", name),
                    f"{project}: {name}@{adv.get('range', v.get('range', ''))}",
                )
            )
    return out


def parse_cargo_deny(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    out = []
    for m in re.finditer(r"^error\[([^\]]+)\]: (.+)$", text, flags=re.M):
        out.append(finding("cargo-deny", "high", m.group(1), m.group(2)))
    return out


def collect(root: str) -> tuple[list[dict], list[str]]:
    findings, sources = [], []
    for dirpath, _, files in os.walk(root):
        for f in sorted(files):
            path = os.path.join(dirpath, f)
            lower = f.lower()
            try:
                if lower.endswith(".sarif") or lower.endswith(".sarif.json"):
                    findings += parse_sarif(path)
                elif lower.startswith("cargo-audit") and lower.endswith(".json"):
                    findings += parse_cargo_audit(path)
                elif lower.startswith("npm-audit") and lower.endswith(".json"):
                    findings += parse_npm_audit(path)
                elif lower.startswith("cargo-deny") and lower.endswith(".txt"):
                    findings += parse_cargo_deny(path)
                else:
                    continue
                sources.append(os.path.relpath(path, root))
            except (OSError, ValueError, KeyError) as exc:
                print(f"warning: could not parse {path}: {exc}", file=sys.stderr)
    # de-duplicate identical findings reported by overlapping scanners
    seen, unique = set(), []
    for fd in findings:
        key = (fd["tool"], fd["id"], fd["location"])
        if key not in seen:
            seen.add(key)
            unique.append(fd)
    unique.sort(key=lambda x: (RANK[x["severity"]], x["category"], x["tool"], x["id"]))
    return unique, sources


def render_markdown(findings: list[dict], sources: list[str], fail_on: str, max_rows: int) -> str:
    by_sev = Counter(f["severity"] for f in findings)
    by_cat: dict[str, Counter] = defaultdict(Counter)
    for f in findings:
        by_cat[f["category"]][f["severity"]] += 1

    blocking = [f for f in findings if RANK[f["severity"]] <= RANK[fail_on]]
    status = "❌ FAIL" if blocking else "✅ PASS"
    lines = [
        "# Security Report",
        "",
        f"**Status:** {status} (threshold: `{fail_on}` and above, {len(blocking)} blocking)",
        "",
        "| Severity | Count |",
        "|---|---|",
        *[f"| {s} | {by_sev.get(s, 0)} |" for s in SEVERITIES],
        "",
        "## By category",
        "",
        "| Category | " + " | ".join(SEVERITIES) + " |",
        "|---|" + "---|" * len(SEVERITIES),
    ]
    for cat in sorted(by_cat):
        lines.append(f"| {cat} | " + " | ".join(str(by_cat[cat].get(s, 0)) for s in SEVERITIES) + " |")
    if not by_cat:
        lines.append("| _none_ | " + " | ".join("0" for _ in SEVERITIES) + " |")

    lines += ["", "## Findings", ""]
    if findings:
        lines += ["| Severity | Tool | ID | Title | Location |", "|---|---|---|---|---|"]
        for f in findings[:max_rows]:
            title = f["title"].replace("|", "\\|")
            lines.append(f"| {f['severity']} | {f['tool']} | `{f['id']}` | {title} | `{f['location']}` |")
        if len(findings) > max_rows:
            lines.append(f"\n_{len(findings) - max_rows} more findings omitted; see security-report.json._")
    else:
        lines.append("No findings.")

    lines += ["", "<details><summary>Scanner inputs</summary>", ""]
    lines += [f"- `{s}`" for s in sources] or ["- _none found_"]
    lines += ["", "</details>", ""]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("reports_dir")
    ap.add_argument("--markdown", default="security-report.md")
    ap.add_argument("--json", default="security-report.json")
    ap.add_argument("--fail-on", default="critical", choices=SEVERITIES + ["none"])
    ap.add_argument("--max-rows", type=int, default=200)
    args = ap.parse_args()

    findings, sources = collect(args.reports_dir)
    fail_on = args.fail_on if args.fail_on != "none" else "info"
    md = render_markdown(findings, sources, fail_on, args.max_rows)

    with open(args.markdown, "w", encoding="utf-8") as fh:
        fh.write(md)
    summary = Counter(f["severity"] for f in findings)
    with open(args.json, "w", encoding="utf-8") as fh:
        json.dump({"summary": {s: summary.get(s, 0) for s in SEVERITIES}, "sources": sources, "findings": findings}, fh, indent=2)

    print(md)
    if args.fail_on == "none":
        return 0
    return 1 if any(RANK[f["severity"]] <= RANK[args.fail_on] for f in findings) else 0


if __name__ == "__main__":
    sys.exit(main())
