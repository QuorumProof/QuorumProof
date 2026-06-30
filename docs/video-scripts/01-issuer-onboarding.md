# Video Script: Issuer Onboarding Workflow

## Metadata
- **Duration**: ~5 minutes
- **Audience**: University administrators, licensing bodies, employers
- **Goal**: Walk through registering as an issuer and configuring issuance settings

---

## Scene 1: Introduction (0:00 - 0:30)

**Visual**: Screen recording of the QuorumProof dashboard landing page.

**Narration**:
"Welcome to QuorumProof. This video walks through the issuer onboarding workflow — how universities, licensing bodies, and employers register to issue verifiable credentials on the Stellar blockchain."

**On-Screen Actions**:
- Open browser to QuorumProof dashboard
- Show login screen

---

## Scene 2: Wallet Connection (0:30 - 1:15)

**Visual**: Freighter wallet connection flow.

**Narration**:
"First, connect your Stellar wallet. QuorumProof uses Freighter, a non-custodial browser wallet. Your Stellar address becomes your on-chain identity."

**On-Screen Actions**:
- Click "Connect Wallet"
- Freighter popup appears
- Select account and approve connection
- Dashboard shows connected address

**Caption**: "Your Stellar address = your on-chain identity"

---

## Scene 3: Role Registration (1:15 - 2:30)

**Visual**: Issuer registration form.

**Narration**:
"Once connected, navigate to the 'Register as Issuer' section. Here you'll provide your organization details. QuorumProof uses a role-based access system — the contract admin grants you the Issuer role. This ensures only verified organizations can issue credentials."

**On-Screen Actions**:
- Navigate to Settings > Roles
- Click "Request Issuer Role"
- Fill in organization name, email, website
- Submit request
- Admin approves (show admin interface briefly)

**Caption**: "Role-based access prevents unauthorized issuers"

---

## Scene 4: Credential Type Configuration (2:30 - 3:45)

**Visual**: Credential type setup interface.

**Narration**:
"Now configure the credential types you'll issue. For a university, this might include 'Bachelor of Science', 'Master of Engineering', or 'Transcript'. Each credential type has a unique ID, name, and optional metadata schema."

**On-Screen Actions**:
- Go to Credential Types > Create New
- Enter type name: "Bachelor of Science in Computer Science"
- Set type ID (auto-generated)
- Optional: upload metadata schema
- Save credential type

**Caption**: "Define credential types that match your institution's offerings"

---

## Scene 5: Single Issuance (3:45 - 4:30)

**Visual**: Issue credential form.

**Narration**:
"You can issue a single credential directly. Enter the recipient's Stellar address, select the credential type, and attach the metadata hash — typically an IPFS pointer to the credential document. The transaction is signed by your wallet and recorded on-chain."

**On-Screen Actions**:
- Go to Credentials > Issue New
- Enter recipient address
- Select credential type
- Enter metadata hash (IPFS CID)
- Set optional expiry date
- Click "Issue" and approve Freighter transaction
- View confirmation with credential ID

---

## Scene 6: Batch Issuance (4:30 - 5:00)

**Visual**: Batch issuance interface (DID-aware).

**Narration**:
"For bulk operations, like importing an entire graduating class, use batch issuance. Upload a CSV or enter multiple recipients at once. This issues all credentials in a single transaction, saving time and reducing costs."

**On-Screen Actions**:
- Go to Credentials > Batch Issue
- Upload CSV with recipient addresses/DIDs and types
- Review the list
- Click "Batch Issue" and approve
- View list of issued credential IDs

**Caption**: "Batch issuance: one transaction, many credentials"

---

## Scene 7: Verification (5:00 - 5:30)

**Visual**: Issuer dashboard showing issued credentials.

**Narration**:
"After issuance, you can verify credentials on-chain, track issuance history, and manage revocations if needed. Your organization now has a verifiable on-chain presence for issuing credentials."

**On-Screen Actions**:
- Show issuer dashboard with credential count
- Click on a credential to view details
- Show verification status

**Closing**: "Thank you for watching. For more details, visit the documentation at docs.quorumproof.io."

---

## Production Notes
- Use a test network (Futurenet) for all demonstrations
- Mask any real addresses if using public network
- Keep cursor movement deliberate and slow
- Use zoom-in effects for form fields and transaction confirmations
- Add subtitles for accessibility
