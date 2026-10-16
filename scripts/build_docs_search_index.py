#!/usr/bin/env python3
"""scripts/build_docs_search_index.py — #1635 Build the interactive-docs search index.

Walks docs/**/*.md, splits each file into sections at Markdown headings, and
writes docs/interactive/search-index.json. The interactive docs page
(docs/interactive/index.html) loads that file for client-side full-text search.

Usage:
    python3 scripts/build_docs_search_index.py            # write the index
    python3 scripts/build_docs_search_index.py --check    # exit 1 if the index is stale

No third-party dependencies.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OUT = DOCS / "interactive" / "search-index.json"

HEADING = re.compile(r"^(#{1,4})\s+(.+?)\s*#*\s*$")
FENCE = re.compile(r"^\s*(```|~~~)")
MAX_TEXT = 600  # characters of body text kept per section


def slugify(text: str) -> str:
    """GitHub-style heading anchor."""
    text = re.sub(r"[`*_\[\]()]", "", text).strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def plain(text: str) -> str:
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[`*_>|#]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def sections(path: Path):
    rel = path.relative_to(DOCS).as_posix()
    title = rel
    current = {"heading": "", "anchor": "", "lines": []}
    in_fence = False
    out = []

    def flush():
        body = plain(" ".join(current["lines"]))
        if current["heading"] or body:
            out.append({
                "doc": rel,
                "title": title,
                "heading": current["heading"],
                "anchor": current["anchor"],
                "text": body[:MAX_TEXT],
            })

    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
            current["lines"].append(line.strip("`~ "))
            continue
        m = None if in_fence else HEADING.match(line)
        if m:
            level, text = len(m.group(1)), plain(m.group(2))
            if level == 1 and title == rel:
                title = text
            flush()
            current = {"heading": text, "anchor": slugify(text), "lines": []}
        else:
            current["lines"].append(line)
    flush()
    for s in out:
        s["title"] = title
    return out


def build() -> str:
    entries = []
    for path in sorted(DOCS.rglob("*.md")):
        entries.extend(sections(path))
    return json.dumps({"version": 1, "entries": entries}, ensure_ascii=False, indent=0) + "\n"


def main() -> int:
    data = build()
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != data:
            print("docs/interactive/search-index.json is stale — run scripts/build_docs_search_index.py")
            return 1
        print("Search index is up to date.")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(data, encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)} ({len(json.loads(data)['entries'])} sections)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
