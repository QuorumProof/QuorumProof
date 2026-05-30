#!/bin/bash
# Issue #590: Auto-generate contract API docs from Rust source comments.
# Outputs to docs/contracts/ with a version stamp matching the contract version.
set -euo pipefail

CONTRACTS=(quorum_proof sbt_registry zk_verifier)
OUT_DIR="docs/contracts"
mkdir -p "$OUT_DIR"

# Derive version from version.rs (major.minor.patch)
VERSION=$(grep -oP 'Version::new\(\K[0-9]+, [0-9]+, [0-9]+' \
  contracts/quorum_proof/src/version.rs | head -1 | tr -d ' ' | tr ',' '.')
VERSION="${VERSION:-unknown}"

echo "Generating contract docs for v${VERSION}..."

for contract in "${CONTRACTS[@]}"; do
  cargo doc \
    --package "$contract" \
    --no-deps \
    --target x86_64-unknown-linux-gnu \
    --document-private-items \
    2>&1 | grep -v "^warning:"

  # Copy generated rustdoc JSON (requires nightly) or fall back to HTML marker
  DOC_HTML="target/x86_64-unknown-linux-gnu/doc/${contract}"
  if [ -d "$DOC_HTML" ]; then
    cp -r "$DOC_HTML" "$OUT_DIR/${contract}"
    echo "  ✓ $contract → $OUT_DIR/${contract}"
  fi
done

# Write a version manifest so docs stay in sync with deployed contracts
cat > "$OUT_DIR/version.json" <<EOF
{
  "version": "${VERSION}",
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "contracts": $(printf '"%s",' "${CONTRACTS[@]}" | sed 's/,$//' | sed 's/^/[/' | sed 's/$/]/')
}
EOF

echo "Docs generated at $OUT_DIR (v${VERSION})"
