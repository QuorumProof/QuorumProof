#!/bin/bash

# Script to create branch and prepare PR for issue #558

cd /workspaces/QuorumProof

# Create a new branch for the metadata fuzzing implementation
BRANCH_NAME="feature/implement-credential-metadata-fuzzing"
git checkout -b "$BRANCH_NAME"

# Add the changes
git add fuzz/fuzz_targets/fuzz_credential_metadata.rs
git add fuzz/Cargo.toml
git add SOLUTION_ISSUE_558.md

# Create commit
git commit -m "feat: Implement fuzzing for credential metadata - closes #558

- Add new fuzz target for credential metadata parsing and validation
- Test 10,000+ metadata variations across different patterns
- Verify no panics or crashes with arbitrary metadata input
- Support empty, maximum, and oversized metadata edge cases
- Generate metadata in 6 different formats (IPFS, hex, random, repeating, UTF-8/binary, high-entropy)

This addresses issue #558 acceptance criteria:
✓ Generate random metadata
✓ Verify no panics or crashes
✓ Support 10,000+ test cases"

# Display branch info
echo "✓ Branch created: $BRANCH_NAME"
echo "✓ Changes committed"
echo "✓ Ready for PR creation"
