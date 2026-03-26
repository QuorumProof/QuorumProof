# Implementation Plan: public-verify-page

## Overview

Surgical fixes to `frontend/src/pages/Verify.tsx` closing six gaps: import migration, `is_attested` wiring, shareable URL query param rename, status banner logic update, ZK claim dropdown alignment, and ZK result + privacy tooltip. A companion test file covers all 7 correctness properties with property-based and unit tests.

## Tasks

- [-] 1. Write property-based and unit tests (correctness exploration)
  - [x] 1.1 Set up test file and extract pure helpers for testing
    - Create `frontend/src/pages/__tests__/Verify.test.tsx`
    - Confirm `fast-check` and `@fast-check/vitest` are available (already in devDependencies)
    - Export or co-locate pure helpers (`buildShareUrl`, `parseIdFromUrl`, `deriveStatus`) so they can be imported by tests
    - _Requirements: 4.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.3, 6.4, 7.2, 7.6, 7.7, 7.9, 8.1, 8.4_

  - [ ]* 1.2 Write property test for Property 1 — Share URL round-trip
    - `// Feature: public-verify-page, Property 1: Share URL round-trip`
    - For any `bigint` in `[1n, 9_999_999n]`, `parseIdFromUrl(buildShareUrl(id)) === id`
    - _Requirements: 6.1, 6.3, 6.4_

  - [ ]* 1.3 Write property test for Property 2 — ClaimType dropdown exhaustiveness
    - `// Feature: public-verify-page, Property 2: ClaimType dropdown exhaustiveness`
    - Render `ZkClaimPanel`, collect all `<option>` values, assert deep-equal to `['HasDegree', 'HasLicense', 'HasEmploymentHistory']`
    - _Requirements: 7.2, 7.3, 8.3_

  - [ ]* 1.4 Write property test for Property 3 — ClaimType encoding invariant
    - `// Feature: public-verify-page, Property 3: ClaimType encoding invariant`
    - For any `c` in `fc.constantFrom('HasDegree', 'HasLicense', 'HasEmploymentHistory')`, `claimTypeToScVal(c)` must be `scvVec([scvSymbol(c)])`
    - _Requirements: 8.1, 8.4_

  - [ ]* 1.5 Write property test for Property 4 — ZK result banner determinism
    - `// Feature: public-verify-page, Property 4: ZK result banner determinism`
    - For any `fc.boolean()`, mock `verifyClaim` to return that value; assert banner text is exactly `'✅ Claim Verified'` or `'❌ Claim Not Verified'`
    - _Requirements: 7.6, 7.7_

  - [ ]* 1.6 Write property test for Property 5 — Empty proof rejection
    - `// Feature: public-verify-page, Property 5: Empty proof rejection`
    - For any string of whitespace chars, submit ZK form; assert `verifyClaim` mock was NOT called and an error message is shown
    - _Requirements: 7.9_

  - [ ]* 1.7 Write property test for Property 6 — Status banner determinism
    - `// Feature: public-verify-page, Property 6: Status banner determinism`
    - For any `fc.record({ revoked, expired, attested: fc.option(fc.boolean()), attestorCount: fc.nat() })`, assert `deriveStatus` returns the correct `statusClass` per priority order: revoked > expired > attested===true > attestorCount>0 > pending
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 4.2, 4.3_

  - [ ]* 1.8 Write property test for Property 7 — Input validation guards
    - `// Feature: public-verify-page, Property 7: Input validation — no on-chain call on bad input`
    - For bad credential IDs (`'0'`, `'-1'`, `'abc'`, any `n <= 0`), assert `getCredential` mock was NOT called
    - For bad addresses (no `G` prefix or length < 56), assert `getCredentialsBySubject` mock was NOT called
    - _Requirements: 2.3, 3.5_

  - [ ]* 1.9 Write unit tests for pure helper functions
    - `credTypeLabel`: known numbers map to expected strings
    - `formatTimestamp`: known timestamps format correctly
    - `formatAddress`: truncates addresses correctly
    - Status banner: specific `(revoked, expired, attested, attestors)` tuples produce correct `statusClass` and `statusTitle`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 2. Gap 1 — Migrate imports in `Verify.tsx`
  - [x] 2.1 Remove contract function imports from `../stellar` and add typed client imports
    - Remove `getCredential`, `getCredentialsBySubject`, `getAttestors`, `isExpired`, `verifyClaim` from the `../stellar` import
    - Add `import { verifyClaim, ClaimType } from '../lib/contracts/zkVerifier'`
    - Add `import { getCredential, getAttestors, isExpired, getCredentialsBySubject, isAttested } from '../lib/contracts/quorumProof'`
    - Keep `decodeMetadataHash`, `CONTRACT_ID`, `RPC_URL`, `NETWORK` in the `../stellar` import
    - _Requirements: 8.1, 8.2_

- [x] 3. Gap 3 — Rename `?credentialId=` query param to `?id=`
  - [x] 3.1 Update all `searchParams` reads and writes to use `id`
    - Change `searchParams.get('credentialId')` → `searchParams.get('id')` (initial state + `useEffect`)
    - Change `setSearchParams({ credentialId: id.toString() })` → `setSearchParams({ id: id.toString() })` in `fetchCred`
    - Change `shareUrl` in `CredentialResult` from `?credentialId=` to `?id=`
    - _Requirements: 6.1, 6.3, 6.4_

- [x] 4. Gap 2 — Wire `is_attested` into `fetchCred` and propagate `attested` prop
  - [x] 4.1 Add `DEFAULT_SLICE_ID` constant and extend `VerifyResult` type
    - Add `const DEFAULT_SLICE_ID = 1n` near the top of the file
    - Update the inline result type (or extract `VerifyResult` interface) to include `attested: boolean | null`
    - _Requirements: 4.1, 4.5_

  - [x] 4.2 Add `isAttested` call to `Promise.all` in `fetchCred`
    - Add `isAttested(id, DEFAULT_SLICE_ID).catch(() => null)` as the fourth element of the `Promise.all`
    - Destructure the result as `attested` and include it in `setResult({ credential, attestors, expired, attested })`
    - _Requirements: 4.1, 4.5_

  - [x] 4.3 Pass `attested` prop through to `CredentialResult`
    - Add `attested: boolean | null` to `CredentialResult` props interface
    - Pass `attested={result.attested}` where `<CredentialResult>` is rendered
    - _Requirements: 4.2, 4.3, 4.5_

- [x] 5. Gap 4 — Update status banner logic to incorporate `attested`
  - [x] 5.1 Rewrite status banner priority logic in `CredentialResult`
    - Priority order: revoked > expired > `attested === true` > `attestors.length > 0` > pending
    - When `attested === null`, show "Attestation status unconfirmed" with a warning variant (`statusClass = 'warning'`)
    - When `attested === true` or `attestors.length > 0`, show "Credential Verified" (`statusClass = 'valid'`)
    - _Requirements: 4.2, 4.3, 4.5, 5.2, 5.3, 5.4, 5.5_

- [x] 6. Gap 5 — Align ZK claim dropdown to on-chain `ClaimType` enum
  - [x] 6.1 Replace dropdown options and update `zkClaimType` state type
    - Change `zkClaimType` state type from `string` to `ClaimType`
    - Set default value to `'HasDegree'`
    - Replace the five `<option>` elements with exactly three:
      - `<option value="HasDegree">🎓 Degree</option>`
      - `<option value="HasLicense">🏛️ License</option>`
      - `<option value="HasEmploymentHistory">💼 Employment History</option>`
    - Remove `zkCustomType` state and the conditional custom-type input row
    - _Requirements: 7.2, 7.3, 8.3_

  - [x] 6.2 Update `handleZkVerify` to use typed `ClaimType` directly
    - Remove the `claimType = zkClaimType === 'custom' ? zkCustomType.trim() : zkClaimType` branch
    - Pass `zkClaimType` (already `ClaimType`) directly to `verifyClaim`
    - _Requirements: 7.5, 8.1, 8.3_

- [x] 7. Gap 6 — Fix ZK result messages and add privacy tooltip
  - [x] 7.1 Update ZK result banner text to exact strings
    - When `verifyClaim` returns `true`: set result message to `'✅ Claim Verified'`
    - When `verifyClaim` returns `false`: set result message to `'❌ Claim Not Verified'`
    - _Requirements: 7.6, 7.7_

  - [x] 7.2 Add ℹ️ privacy tooltip after the ZK result banner
    - After the `zkResult` banner, render a `<span>` (or `<button>`) with:
      - `title="Zero-knowledge proofs confirm a property of a credential (e.g. holds a degree) without revealing the credential data itself. The proof is verified entirely on-chain."`
      - `aria-label="About zero-knowledge proofs"`
      - Inner text: `ℹ️`
    - Only render the tooltip when `zkResult` is non-null
    - _Requirements: 7.8_

- [ ] 8. Checkpoint — Ensure all tests pass
  - Run `vitest --run` in `frontend/` and confirm all property and unit tests pass.
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- `fast-check` and `@fast-check/vitest` are already present in `devDependencies`
- Tasks 2–7 are all changes to `frontend/src/pages/Verify.tsx`; task 1 creates `frontend/src/pages/__tests__/Verify.test.tsx`
- Property tests reference design.md properties by number for traceability
- The `attested === null` warning path (Gap 4) is the only new status-banner variant; all other variants already exist
