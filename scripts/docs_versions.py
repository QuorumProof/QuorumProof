#!/usr/bin/env python3
"""scripts/docs_versions.py — #1642 Manage versioned documentation.

Documentation versions are git refs. `main` is always "latest"; each release
line gets a maintenance branch `docs/v<MAJOR.MINOR>` cut from the release
commit. docs/versions.json is the manifest the interactive docs version
switcher (docs/interactive/index.html) reads. See
docs/documentation-versioning.md for the full policy.

Usage:
    python3 scripts/docs_versions.py list
    python3 scripts/docs_versions.py cut <MAJOR.MINOR> [--ref <commit>] [--no-branch]
    python3 scripts/docs_versions.py deprecate <MAJOR.MINOR> [--eol YYYY-MM-DD]
    python3 scripts/docs_versions.py eol <MAJOR.MINOR>
    python3 scripts/docs_versions.py check

`cut` creates the local branch `docs/v<version>` (push it yourself) and adds
the version to the manifest as "supported". `deprecate` defaults the EOL date
to 180 days from today, per the deprecation policy. `check` validates the
manifest and is intended for CI.

No third-party dependencies.
"""

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "docs" / "versions.json"

STATUSES = ("current", "supported", "deprecated", "eol")
VERSION_RE = re.compile(r"^\d+\.\d+$")
DEPRECATION_WINDOW_DAYS = 180


def load() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def save(data: dict) -> None:
    data["versions"].sort(key=sort_key)
    MANIFEST.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def sort_key(v: dict):
    # "latest" first, then numeric versions newest-first.
    if v["version"] == "latest":
        return (0, 0, 0)
    major, minor = (int(p) for p in v["version"].split("."))
    return (1, -major, -minor)


def find(data: dict, version: str) -> dict:
    for v in data["versions"]:
        if v["version"] == version:
            return v
    sys.exit(f"error: version {version} is not in {MANIFEST.relative_to(ROOT)}")


def today() -> str:
    return dt.date.today().isoformat()


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True,
                          capture_output=True, text=True).stdout.strip()


def cmd_list(_args) -> int:
    data = load()
    print(f"{'VERSION':<10} {'STATUS':<11} {'REF':<14} {'RELEASED':<11} {'EOL':<11}")
    for v in data["versions"]:
        print(f"{v['version']:<10} {v['status']:<11} {v['ref']:<14} "
              f"{v.get('released') or '-':<11} {v.get('eol') or '-':<11}")
    return 0


def cmd_cut(args) -> int:
    version = args.version
    if not VERSION_RE.match(version):
        sys.exit("error: version must be MAJOR.MINOR, e.g. 1.2")
    data = load()
    if any(v["version"] == version for v in data["versions"]):
        sys.exit(f"error: version {version} already exists")

    branch = f"docs/v{version}"
    if not args.no_branch:
        git("branch", branch, args.ref)
        print(f"Created branch {branch} at {git('rev-parse', '--short', args.ref)}")
        print(f"  push it with: git push upstream {branch}")

    data["versions"].append({
        "version": version,
        "label": f"v{version}",
        "ref": branch,
        "status": "supported",
        "released": today(),
        "deprecated": None,
        "eol": None,
    })
    save(data)
    print(f"Added v{version} to {MANIFEST.relative_to(ROOT)} as supported")
    return 0


def cmd_deprecate(args) -> int:
    data = load()
    v = find(data, args.version)
    if v["status"] == "current":
        sys.exit("error: the current (latest) docs cannot be deprecated")
    eol = args.eol or (dt.date.today() + dt.timedelta(days=DEPRECATION_WINDOW_DAYS)).isoformat()
    v.update(status="deprecated", deprecated=today(), eol=eol)
    save(data)
    print(f"v{args.version} deprecated; end of life {eol}")
    return 0


def cmd_eol(args) -> int:
    data = load()
    v = find(data, args.version)
    if v["status"] != "deprecated":
        sys.exit("error: a version must be deprecated before it reaches end of life")
    v.update(status="eol", eol=v.get("eol") or today())
    save(data)
    print(f"v{args.version} marked end of life")
    return 0


def cmd_check(_args) -> int:
    errors = []
    try:
        data = load()
    except (OSError, json.JSONDecodeError) as e:
        print(f"[FAIL] cannot read manifest: {e}")
        return 1

    versions = data.get("versions", [])
    current = [v for v in versions if v.get("status") == "current"]
    if len(current) != 1:
        errors.append(f"exactly one version must be 'current' (found {len(current)})")
    if data.get("default") not in {v.get("version") for v in versions}:
        errors.append(f"default '{data.get('default')}' is not a listed version")

    seen = set()
    for v in versions:
        name = v.get("version", "?")
        if name in seen:
            errors.append(f"{name}: duplicate version")
        seen.add(name)
        if name != "latest" and not VERSION_RE.match(name):
            errors.append(f"{name}: version must be 'latest' or MAJOR.MINOR")
        if v.get("status") not in STATUSES:
            errors.append(f"{name}: status must be one of {', '.join(STATUSES)}")
        if not v.get("ref"):
            errors.append(f"{name}: ref is required")
        if v.get("status") in ("deprecated", "eol") and not v.get("eol"):
            errors.append(f"{name}: deprecated/eol versions need an eol date")
        for field in ("released", "deprecated", "eol"):
            if v.get(field):
                try:
                    dt.date.fromisoformat(v[field])
                except ValueError:
                    errors.append(f"{name}: {field} must be YYYY-MM-DD")

    for e in errors:
        print(f"  [FAIL] {e}")
    if errors:
        return 1
    print(f"==> {MANIFEST.relative_to(ROOT)} is valid ({len(versions)} versions)")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Manage versioned documentation (#1642)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list").set_defaults(fn=cmd_list)
    c = sub.add_parser("cut")
    c.add_argument("version")
    c.add_argument("--ref", default="HEAD", help="commit to branch from (default HEAD)")
    c.add_argument("--no-branch", action="store_true", help="only update the manifest")
    c.set_defaults(fn=cmd_cut)
    d = sub.add_parser("deprecate")
    d.add_argument("version")
    d.add_argument("--eol", help="end-of-life date, YYYY-MM-DD (default +180 days)")
    d.set_defaults(fn=cmd_deprecate)
    e = sub.add_parser("eol")
    e.add_argument("version")
    e.set_defaults(fn=cmd_eol)
    sub.add_parser("check").set_defaults(fn=cmd_check)
    args = p.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
