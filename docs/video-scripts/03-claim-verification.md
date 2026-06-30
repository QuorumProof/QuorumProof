# Video Script: Claim Verification Workflow

## Metadata
- **Duration**: ~5 minutes
- **Audience**: Employers, hiring managers, verification platforms
- **Goal**: Demonstrate how to verify credential claims with privacy-preserving ZK proofs

---

## Scene 1: Introduction (0:00 - 0:30)

**Visual**: Split screen — left shows a hiring manager, right shows the verification interface.

**Narration**:
"QuorumProof enables privacy-preserving credential verification. Instead of asking candidates to share their full diploma or transcript, you can verify specific claims — like 'has a Bachelor's degree in Computer Science' — without seeing any additional data. This video walks through the verification workflow."

**On-Screen Actions**:
- Show typical scenario: hiring manager reviewing an applicant
- "Verify credential claim" button in the hiring platform

---

## Scene 2: Understanding Claims vs. Full Credentials (0:30 - 1:15)

**Visual**: Comparison table or infographic.

**Narration**:
"Traditional verification requires sharing the full credential — diploma, transcript, or certificate — revealing more information than necessary. QuorumProof uses zero-knowledge proofs, allowing the candidate to prove specific claims while keeping the rest private."

**On-Screen Actions**:
- Left column: "Full Disclosure" — shows diploma with GPA, courses, personal info
- Right column: "ZK Claim" — shows only "Degree: BS Computer Science ✓"
- Highlight: "No additional data revealed"

**Caption**: "Zero-knowledge proofs: verify what matters, nothing more"

---

## Scene 3: Initiating a Verification Request (1:15 - 2:15)

**Visual**: Verification request form.

**Narration**:
"As a verifier, you start by requesting proof of a specific claim. Enter the candidate's Stellar address or DID, select the claim type you need verified, and optionally add a verification context."

**On-Screen Actions**:
- Navigate to "Verify Credential" page
- Enter candidate's Stellar address: "GA2GB5B..."
- Select claim type: "HasDegree"
- Enter context: "Bachelor of Science in Computer Science"
- Optional: set query deadline
- Click "Request Verification"

**Caption**: "Specify exactly what you need to verify"

---

## Scene 4: Candidate Generates ZK Proof (2:15 - 3:00)

**Visual**: Screen recording of candidate's proof generation interface.

**Narration**:
"The verification request is sent to the candidate. They receive a notification and can review what claim is being requested. If they agree, they generate a zero-knowledge proof using their credential metadata. This proof cryptographically confirms the claim without revealing the underlying data."

**On-Screen Actions**:
- Switch to candidate's view
- Show notification: "Verification request received"
- Click "Review Request"
- Show claim details: "HasDegree: BS Computer Science"
- Click "Generate Proof"
- Wallet signs the proof generation
- Progress bar: "Generating ZK proof..."
- Proof generated successfully

**Caption**: "Candidate controls what to reveal"

---

## Scene 5: Submitting the Proof (3:00 - 3:30)

**Visual**: Proof submission flow.

**Narration**:
"The candidate submits the proof. It's posted on-chain to the QuorumProof ZK verifier contract, which validates the proof against the stored credential metadata."

**On-Screen Actions**:
- Candidate clicks "Submit Proof"
- Freighter transaction approval
- Loading: "Verifying proof on-chain..."
- Success: "Proof submitted and verified"

---

## Scene 6: Verifier Reviews Result (3:30 - 4:30)

**Visual**: Verification result display.

**Narration**:
"Back in the verifier's dashboard, the result appears. You see the claim, whether it was verified, and the cryptographic proof ID. You can trust this result because it's verified on-chain by the Soroban contract."

**On-Screen Actions**:
- Switch to verifier's view
- Refresh verification requests
- Show completed verification:
  - Claim: HasDegree
  - Context: BS Computer Science
  - Status: ✓ Verified
  - Proof ID: 0x7a3f...9c2e
  - Timestamp: June 26, 2026
- Click "View Proof Details"
- Show proof metadata (not the underlying data)

**Caption**: "Cryptographically verified on Stellar Soroban"

---

## Scene 7: Advanced Verification (4:30 - 5:00)

**Visual**: Advanced verification options.

**Narration**:
"For more complex needs, QuorumProof supports conditional and composite claims — like 'has a degree AND graduated after 2020', or 'has at least 3 years of experience'. You can also batch-verify multiple candidates or claims in a single transaction."

**On-Screen Actions**:
- Show composite claim builder:
  - Claim 1: HasDegree (AND)
  - Claim 2: GraduatedAfter (2020)
- Show batch verification:
  - Upload CSV with multiple candidates and claims
  - Click "Batch Verify"
  - Show results table with pass/fail for each

**Caption**: "Composite claims for complex verification needs"

---

## Scene 8: Audit Trail (5:00 - 5:30)

**Visual**: Verification audit log.

**Narration**:
"Every verification is recorded in an immutable audit trail. You can view the history of all verification requests and their results, providing a transparent hiring process for compliance and auditing."

**On-Screen Actions**:
- Navigate to "Verification History"
- Show table with columns: Date, Candidate, Claim, Status, Verifier
- Filter by date range
- Export audit log as CSV

**Closing**: "QuorumProof makes credential verification private, secure, and auditable. For technical details on the ZK implementation, see the ZK verification documentation."

---

## Production Notes
- Use test credentials on Futurenet for all demonstrations
- Show both issuer and verifier perspectives
- Emphasize that no private data is visible to the verifier
- Include a side-by-side comparison with traditional (full disclosure) verification
- Add subtitles and closed captions
- Include links to ZK verification documentation in video description
