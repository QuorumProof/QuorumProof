#!/bin/bash
set -e

echo "🔧 Setting up PR for Issue #558..."

# Create and checkout branch
echo "📌 Creating feature branch..."
git checkout -b feature/implement-credential-metadata-fuzzing

# Stage files
echo "📝 Staging files..."
git add fuzz/fuzz_targets/fuzz_credential_metadata.rs
git add fuzz/Cargo.toml  
git add SOLUTION_ISSUE_558.md

# Create commit
echo "💾 Creating commit..."
git commit -m "feat: Implement fuzzing for credential metadata - closes #558

- Add new fuzz target for credential metadata parsing and validation
- Test 10,000+ metadata variations across different patterns
- Verify no panics or crashes with arbitrary metadata input
- Support empty, maximum, and oversized metadata edge cases
- Generate metadata in 6 different formats

Acceptance criteria met:
✓ Generate random metadata
✓ Verify no panics or crashes
✓ Support 10,000+ test cases"

# Push to origin
echo "🚀 Pushing branch to origin..."
git push -u origin feature/implement-credential-metadata-fuzzing

echo "✅ Complete! Branch created and pushed."
echo ""
echo "Branch: feature/implement-credential-metadata-fuzzing"
echo "Next: Create PR at https://github.com/QuorumProof/QuorumProof/pull/new/feature/implement-credential-metadata-fuzzing"
