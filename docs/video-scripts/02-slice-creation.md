# Video Script: Slice Creation Workflow

## Metadata
- **Duration**: ~6 minutes
- **Audience**: Credential holders (engineers, professionals)
- **Goal**: Demonstrate how to create and configure quorum slices for credential attestation

---

## Scene 1: Introduction (0:00 - 0:30)

**Visual**: Animated diagram showing trust relationships between a credential holder, university, employer, and licensing body.

**Narration**:
"In QuorumProof, credentials aren't just issued — they're attested by your trusted network. This is done through quorum slices. A quorum slice defines who you trust to vouch for your credentials. This video shows how to create and manage your slices."

**On-Screen Actions**:
- Animated diagram: central figure (holder) connected to 3 nodes (university, employer, licensing body)
- Arrows showing attestation flow

---

## Scene 2: Understanding Quorum Slices (0:30 - 1:30)

**Visual**: Split screen — left side shows slice diagram, right side shows the Slice Manager UI.

**Narration**:
"A quorum slice is a set of attestors you trust, each with a weight, plus a threshold. A credential is considered attested when the sum of attestation weights meets or exceeds your threshold. For example, you might give your university weight 2, your employer weight 1, and set threshold 2 — meaning either your university alone, or your employer plus another attestor, can attest."

**On-Screen Actions**:
- Show slice structure diagram:
  - Attestors: University (weight 2), Employer (weight 1), Licensing Body (weight 1)
  - Threshold: 2
- Highlight different combinations that meet threshold

**Caption**: "Threshold = minimum weight needed for attestation"

---

## Scene 3: Navigating to Slice Manager (1:30 - 2:00)

**Visual**: Dashboard navigation.

**Narration**:
"To create a slice, navigate to the 'Quorum Slices' section from your dashboard."

**On-Screen Actions**:
- Log into dashboard
- Click "Quorum Slices" in sidebar
- Show empty slice list with "Create New Slice" button

---

## Scene 4: Creating a Slice (2:00 - 3:30)

**Visual**: Slice creation form.

**Narration**:
"Click 'Create New Slice'. Give your slice a name — like 'Professional Network' or 'Academic Attestors'. Then add your trusted attestors. Each attestor is identified by their Stellar address or DID. You can also look up organizations by name."

**On-Screen Actions**:
- Click "Create New Slice"
- Enter slice name: "Professional Network"
- Click "Add Attestor"
- Enter university's Stellar address
- Set weight: 2
- Add employer's Stellar address
- Set weight: 1
- Add licensing body's Stellar address
- Set weight: 1

**Caption**: "Add attestors by Stellar address or DID"

---

## Scene 5: Setting Threshold (3:30 - 4:15)

**Visual**: Threshold configuration.

**Narration**:
"Now set your threshold. The tooltip shows you the total available weight. For maximum security, set threshold to 100% of total weight — requiring all attestors to agree. For flexibility, use a majority threshold like 67% or 51%."

**On-Screen Actions**:
- Show threshold slider
- Total weight shows: 4
- Move slider: 67% (threshold = 3)
- Explain: "67% means 3 out of 4 weight must attest"
- Move to 51% (threshold = 2)
- Explain: "51% for more lenient attestation"

**Caption**: "Recommended: start with 67% threshold"

---

## Scene 6: Advanced Options (4:15 - 5:00)

**Visual**: Advanced configuration panel.

**Narration**:
"Advanced options let you set weighted voting rules, define attestation expiry, and configure slice-based verification conditions. For most users, the defaults work well."

**On-Screen Actions**:
- Expand "Advanced Options"
- Show weighted voting settings
- Show attestation expiry (default: never)
- Show verification conditions
- Leave at defaults

---

## Scene 7: Review and Confirm (5:00 - 5:30)

**Visual**: Slice summary before confirmation.

**Narration**:
"Review your slice configuration. You'll see the total weight, threshold, and list of attestors. Confirm by signing the transaction with your wallet."

**On-Screen Actions**:
- Click "Review" or "Next"
- Show summary card:
  - Slice Name: Professional Network
  - Attestors: 3
  - Total Weight: 4
  - Threshold: 3 (67%)
- Click "Confirm & Sign"
- Freighter popup — approve transaction
- Success message: "Slice created successfully!"

---

## Scene 8: Managing Slices (5:30 - 6:00)

**Visual**: Slice management dashboard.

**Narration**:
"After creation, you can view, edit, or deactivate your slices. Each slice shows its attestation status for your credentials. You can create multiple slices for different contexts — professional, academic, or personal."

**On-Screen Actions**:
- Show slice list with new slice visible
- Click on slice to view details
- Show "Edit" and "Deactivate" buttons
- Show attestation progress for linked credentials

**Closing**: "Your quorum slices are the foundation of trust in QuorumProof. Create slices that reflect your real-world professional relationships."

---

## Production Notes
- Use clear, labeled diagrams for the FBA concept
- Show real Stellar addresses (testnet) so viewers recognize the format
- Highlight the relationship between slice composition and attestation outcomes
- Include warning text for low threshold settings
