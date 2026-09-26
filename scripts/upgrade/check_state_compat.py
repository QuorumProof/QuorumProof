#!/usr/bin/env python3
"""
Issue #1630: Static state-compatibility check for contract upgrades.

Compares the Soroban contract sources at a base git ref (the code currently
deployed / on main) against the working tree and fails if the new code would
break existing on-chain state or existing clients.

Rules enforced (see docs/upgrade-testing.md and ADR-011):

  1. `#[contracterror]` variants must keep their numeric discriminants and must
     not be removed. New variants may only be appended.
  2. Storage key enums (`DataKey`, `DataKey2`, ...) must not lose or rename
     variants, and a variant's payload types must not change. Soroban encodes
     enum variants by name, so a rename orphans every stored entry.
  3. `#[contracttype]` structs must keep every existing field with the same
     type. Soroban encodes structs as maps keyed by field name; removing,
     renaming or retyping a field makes stored entries undecodable. Adding a
     field is reported as a WARNING because old entries will lack it and need a
     `migrate_state` arm.
  4. Public contract functions (`pub fn` inside `#[contractimpl]`) must not be
     removed and must keep their parameter list.

Usage:
    python3 scripts/upgrade/check_state_compat.py [--base origin/main] [--json out.json]

Exit code: 0 = compatible, 1 = breaking changes found, 2 = usage error.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field

CONTRACT_SOURCES = [
    "contracts/quorum_proof/src/lib.rs",
    "contracts/sbt_registry/src/lib.rs",
    "contracts/zk_verifier/src/lib.rs",
]

ATTR_RE = re.compile(r"#\[(contracttype|contracterror)\]")
ITEM_RE = re.compile(r"\bpub\s+(struct|enum)\s+(\w+)")
IMPL_RE = re.compile(r"#\[contractimpl\]\s*impl\s+(?:\w+\s+for\s+)?(\w+)")
FN_RE = re.compile(r"\bpub\s+fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(")


@dataclass
class ContractShape:
    errors: dict[str, dict[str, int]] = field(default_factory=dict)
    enums: dict[str, dict[str, str]] = field(default_factory=dict)
    structs: dict[str, dict[str, str]] = field(default_factory=dict)
    functions: dict[str, str] = field(default_factory=dict)


def strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def match_brace(src: str, open_idx: int, open_ch: str = "{", close_ch: str = "}") -> int:
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == open_ch:
            depth += 1
        elif src[i] == close_ch:
            depth -= 1
            if depth == 0:
                return i
    return len(src) - 1


def split_top_level(body: str) -> list[str]:
    parts, depth, cur = [], 0, []
    for ch in body:
        if ch in "<({[":
            depth += 1
        elif ch in ">)}]":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if "".join(cur).strip():
        parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


def norm(s: str) -> str:
    return re.sub(r"\s+", "", s)


def parse_source(src: str) -> ContractShape:
    src = strip_comments(src)
    shape = ContractShape()

    for attr in ATTR_RE.finditer(src):
        item = ITEM_RE.search(src, attr.end())
        if not item:
            continue
        kind, name = item.group(1), item.group(2)
        brace = src.find("{", item.end())
        semi = src.find(";", item.end())
        if brace == -1 or (semi != -1 and semi < brace):
            continue  # tuple / unit struct
        body = src[brace + 1 : match_brace(src, brace)]
        members = [re.sub(r"#\[[^\]]*\]", "", m).strip() for m in split_top_level(body)]

        if attr.group(1) == "contracterror":
            variants = {}
            for m in members:
                mm = re.match(r"(\w+)\s*=\s*(\d+)", m)
                if mm:
                    variants[mm.group(1)] = int(mm.group(2))
            shape.errors[name] = variants
        elif kind == "enum":
            variants = {}
            for m in members:
                mm = re.match(r"(\w+)\s*(.*)", m, flags=re.S)
                if mm:
                    variants[mm.group(1)] = norm(mm.group(2))
            shape.enums[name] = variants
        else:
            fields = {}
            for m in members:
                mm = re.match(r"(?:pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*(.+)", m, flags=re.S)
                if mm:
                    fields[mm.group(1)] = norm(mm.group(2))
            shape.structs[name] = fields

    for impl in IMPL_RE.finditer(src):
        brace = src.find("{", impl.end() - 1)
        end = match_brace(src, brace)
        block = src[brace:end]
        for fn in FN_RE.finditer(block):
            paren = block.find("(", fn.end() - 1)
            params = block[paren + 1 : match_brace(block, paren, "(", ")")]
            shape.functions[fn.group(1)] = norm(params)

    return shape


def git_show(ref: str, path: str) -> str | None:
    try:
        return subprocess.run(
            ["git", "show", f"{ref}:{path}"], check=True, capture_output=True, text=True
        ).stdout
    except subprocess.CalledProcessError:
        return None


def compare(path: str, old: ContractShape, new: ContractShape) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    for enum, old_vars in old.errors.items():
        new_vars = new.errors.get(enum)
        if new_vars is None:
            errors.append(f"{path}: error enum `{enum}` was removed")
            continue
        for var, code in old_vars.items():
            if var not in new_vars:
                errors.append(f"{path}: error `{enum}::{var}` (= {code}) was removed")
            elif new_vars[var] != code:
                errors.append(
                    f"{path}: error `{enum}::{var}` renumbered {code} -> {new_vars[var]}"
                )
        old_codes = set(old_vars.values())
        for var, code in new_vars.items():
            if var not in old_vars and code in old_codes:
                errors.append(f"{path}: error `{enum}::{var}` reuses existing code {code}")

    for enum, old_vars in old.enums.items():
        new_vars = new.enums.get(enum)
        if new_vars is None:
            errors.append(f"{path}: contracttype enum `{enum}` was removed")
            continue
        for var, payload in old_vars.items():
            if var not in new_vars:
                errors.append(f"{path}: variant `{enum}::{var}` was removed or renamed")
            elif new_vars[var] != payload:
                errors.append(
                    f"{path}: variant `{enum}::{var}` payload changed `{payload}` -> `{new_vars[var]}`"
                )

    for struct, old_fields in old.structs.items():
        new_fields = new.structs.get(struct)
        if new_fields is None:
            errors.append(f"{path}: contracttype struct `{struct}` was removed")
            continue
        for fname, ftype in old_fields.items():
            if fname not in new_fields:
                errors.append(f"{path}: field `{struct}.{fname}` was removed or renamed")
            elif new_fields[fname] != ftype:
                errors.append(
                    f"{path}: field `{struct}.{fname}` type changed `{ftype}` -> `{new_fields[fname]}`"
                )
        for fname in new_fields.keys() - old_fields.keys():
            warnings.append(
                f"{path}: field `{struct}.{fname}` added; stored `{struct}` entries need a migrate_state arm"
            )

    for fn, params in old.functions.items():
        if fn not in new.functions:
            errors.append(f"{path}: public function `{fn}` was removed")
        elif new.functions[fn] != params:
            errors.append(f"{path}: public function `{fn}` signature changed")

    return errors, warnings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="origin/main", help="git ref of the currently deployed code")
    ap.add_argument("--json", help="write a machine-readable report to this path")
    args = ap.parse_args()

    all_errors: list[str] = []
    all_warnings: list[str] = []
    for path in CONTRACT_SOURCES:
        old_src = git_show(args.base, path)
        if old_src is None:
            all_warnings.append(f"{path}: not present at {args.base}, skipping (new contract)")
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                new_src = fh.read()
        except FileNotFoundError:
            all_errors.append(f"{path}: contract source was deleted")
            continue
        errs, warns = compare(path, parse_source(old_src), parse_source(new_src))
        all_errors += errs
        all_warnings += warns

    for w in all_warnings:
        print(f"WARNING: {w}")
    for e in all_errors:
        print(f"ERROR:   {e}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(
                {"base": args.base, "compatible": not all_errors, "errors": all_errors, "warnings": all_warnings},
                fh,
                indent=2,
            )

    if all_errors:
        print(f"\nUpgrade compatibility check FAILED: {len(all_errors)} breaking change(s).")
        return 1
    print(f"\nUpgrade compatibility check passed ({len(all_warnings)} warning(s)).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
