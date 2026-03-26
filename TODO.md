# SBT Duplicate Mint Bug Fix - ISSUE

Current Status: Code logic exists but lib.rs has syntax errors/duplicates preventing compilation/tests. No snapshot for duplicate test.

## Plan Steps:
1. Fix contracts/sbt_registry/src/lib.rs:
   - Remove duplicate DataKey, imports, constants.
   - Clean mint function: simple version with duplicate check (matching tests).
   - Add QP validation optionally if needed.
   - Fix test_duplicate_sbt_minting_rejection and others.
   - Clean transfer test, persistence test.

2. cd contracts/sbt_registry && cargo test  # Generate snapshots including duplicate rejection.

3. Verify: cd contracts/sbt_registry && cargo build

4. [ ] Update this TODO with completion.

5. Create PR if needed.

**Next Action:** Implement lib.rs fixes.

