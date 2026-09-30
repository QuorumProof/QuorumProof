#!/usr/bin/env python3
"""
scripts/test_snippets.py — Validate QuorumProof snippet definitions.
Checks:
- All .code-snippets files are valid JSON.
- Every snippet has prefix, description, body.
- Prefix naming adheres to 'qp-*' convention.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNIPPET_FILES = [
    ROOT / ".vscode" / "quorumproof.code-snippets",
    ROOT / "snippets" / "vscode" / "quorumproof.code-snippets",
]

def validate_snippets():
    total_snippets = 0
    errors = []

    for file_path in SNIPPET_FILES:
        if not file_path.exists():
            errors.append(f"Missing snippet file: {file_path}")
            continue

        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            errors.append(f"Failed to parse JSON in {file_path}: {e}")
            continue

        if not isinstance(data, dict):
            errors.append(f"Expected root object in {file_path}")
            continue

        print(f"Validating {file_path.relative_to(ROOT)} ({len(data)} snippets)...")

        for name, snippet in data.items():
            total_snippets += 1
            if "prefix" not in snippet:
                errors.append(f"Snippet '{name}' in {file_path} missing 'prefix'")
            elif not snippet["prefix"].startswith("qp-"):
                errors.append(f"Snippet '{name}' prefix '{snippet['prefix']}' should start with 'qp-'")

            if "body" not in snippet:
                errors.append(f"Snippet '{name}' in {file_path} missing 'body'")

            if "description" not in snippet:
                errors.append(f"Snippet '{name}' in {file_path} missing 'description'")

    if errors:
        print("\nErrors found:")
        for err in errors:
            print(f"  - {err}")
        sys.exit(1)

    print(f"\nAll snippet files are valid. Verified {total_snippets} snippet definitions.")

if __name__ == "__main__":
    validate_snippets()
