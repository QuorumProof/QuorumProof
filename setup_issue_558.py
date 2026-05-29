#!/usr/bin/env python3
"""
Automated script to create branch and PR for issue #558
This script handles git operations to set up the fuzzing implementation
"""

import subprocess
import sys
import os

def run_command(cmd, description):
    """Run a shell command and return the result"""
    print(f"\n📋 {description}...")
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd='/workspaces/QuorumProof')
        if result.returncode != 0:
            print(f"❌ Error: {result.stderr}")
            return None
        print(f"✅ {description} - Success")
        return result.stdout.strip()
    except Exception as e:
        print(f"❌ Exception: {e}")
        return None

def main():
    os.chdir('/workspaces/QuorumProof')
    
    print("=" * 60)
    print("Issue #558: Implement Fuzzing for Credential Metadata")
    print("=" * 60)
    
    # Verify files exist
    files_to_check = [
        'fuzz/fuzz_targets/fuzz_credential_metadata.rs',
        'fuzz/Cargo.toml',
        'SOLUTION_ISSUE_558.md'
    ]
    
    print("\n🔍 Verifying required files...")
    for file in files_to_check:
        if os.path.exists(file):
            print(f"  ✅ {file}")
        else:
            print(f"  ❌ {file} - NOT FOUND")
            sys.exit(1)
    
    # Create branch
    branch_name = "feature/implement-credential-metadata-fuzzing"
    run_command(f"git checkout -b {branch_name}", f"Creating branch '{branch_name}'")
    
    # Stage files
    print("\n📝 Staging files...")
    for file in files_to_check:
        run_command(f"git add {file}", f"Staging {file}")
    
    # Show status
    print("\n📊 Git status:")
    run_command("git status", "Checking git status")
    
    # Create commit
    commit_msg = """feat: Implement fuzzing for credential metadata - closes #558

- Add new fuzz target for credential metadata parsing and validation
- Test 10,000+ metadata variations across different patterns
- Verify no panics or crashes with arbitrary metadata input
- Support empty, maximum, and oversized metadata edge cases
- Generate metadata in 6 different formats

Acceptance criteria met:
✓ Generate random metadata
✓ Verify no panics or crashes
✓ Support 10,000+ test cases"""
    
    result = run_command(f'git commit -m "{commit_msg}"', "Creating commit")
    
    # Get commit details
    if result:
        commit_hash = run_command("git rev-parse HEAD", "Getting commit hash")
        branch = run_command("git branch --show-current", "Getting branch name")
        
        print("\n" + "=" * 60)
        print("✅ SETUP COMPLETE")
        print("=" * 60)
        print(f"Branch: {branch}")
        print(f"Commit: {commit_hash}")
        print("\n📤 Next steps:")
        print("1. Push to origin:")
        print(f"   git push -u origin {branch}")
        print("\n2. Create PR on GitHub with SOLUTION_ISSUE_558.md content")
        print("=" * 60)
    else:
        print("\n❌ Failed to create commit")
        sys.exit(1)

if __name__ == '__main__':
    main()
