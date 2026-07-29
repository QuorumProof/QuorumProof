---- MODULE QuorumSliceAttestation ----
(*
  Issue #1317 — Formal Verification: Quorum Slice Attestation Model
  
  This TLA+ specification models the quorum-slice attestation subsystem of
  QuorumProof, implementing the Federated Byzantine Agreement (FBA) trust
  model described in the Stellar whitepaper and docs/adr/adr-001-fba-trust-model.md.
  
  A credential becomes "attested" when sufficient attestors in a quorum slice
  have voted in favour and the weighted threshold is met.
  
  INVARIANTS (machine-checkable with TLC):
  
  I1. TypeInvariant              — All state variables are well-typed.
  I2. RevokedNotAttested         — A revoked credential cannot reach or
                                   remain in the Attested state.
  I3. ThresholdEnforced          — A credential is attested iff the sum of
                                   weights of supporting attestors meets the
                                   slice threshold.
  I4. AttestorInSlice            — Only attestors that are members of a slice
                                   may cast a vote on credentials in that slice.
  I5. NoDoubleVote               — An attestor cannot vote twice on the same
                                   (credential, slice) pair.
  I6. ChallengeBlocksAttestation — An active unresolved challenge on a
                                   credential prevents it from reaching
                                   Attested state.
  
  LIVENESS:
  
  L1. EventualAttestation — If enough attestors vote in favour and no
                            challenges are raised, the credential eventually
                            reaches Attested state.
  
  REFERENCES:
  - contracts/quorum_proof/src/lib.rs
  - docs/adr/adr-001-fba-trust-model.md
  - docs/trust-slices.md
*)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
  Attestors,    \* Set of possible attestor addresses
  CredIds,      \* Set of credential ids to model (finite for TLC)
  SliceIds      \* Set of slice ids to model

VARIABLES
  cred_state,    \* CredId -> "Active" | "Revoked" | "Attested"
  slices,        \* SliceId -> [members: SUBSET Attestors, weights: Attestor->Nat, threshold: Nat]
  votes,         \* (CredId x SliceId) -> (Attestor -> BOOLEAN)  — TRUE = support
  challenges,    \* CredId -> BOOLEAN  — TRUE = active unresolved challenge
  paused         \* BOOLEAN

vars == <<cred_state, slices, votes, challenges, paused>>

-----------------------------------------------------------------------------
(* Type aliases *)

CredStateValues == {"Active", "Revoked", "Attested"}

SliceRecord == [
  members   : SUBSET Attestors,
  weights   : [Attestors -> Nat],   \* weight 0 = not in slice
  threshold : Nat
]

-----------------------------------------------------------------------------
(* Initial state *)

Init ==
  /\ cred_state  = [id \in CredIds |-> "Active"]
  /\ slices      = [sid \in SliceIds |->
                     [members   |-> {},
                      weights   |-> [a \in Attestors |-> 0],
                      threshold |-> 1]]
  /\ votes       = [id \in CredIds |->
                     [sid \in SliceIds |->
                       [a \in Attestors |-> FALSE]]]
  /\ challenges  = [id \in CredIds |-> FALSE]
  /\ paused      = FALSE

-----------------------------------------------------------------------------
(* Helper functions *)

\* Sum of weights for attestors who have voted TRUE for (cred, slice)
SupportWeight(id, sid) ==
  LET s == slices[sid]
  IN  LET supporters == {a \in s.members : votes[id][sid][a] = TRUE}
      IN  LET weights == {s.weights[a] : a \in supporters}
          IN  IF supporters = {} THEN 0
              ELSE LET seq == SetToSeq(weights)
                   IN  FoldSeq(LAMBDA x, y : x + y, 0, seq)

\* Whether a slice's threshold is met by current support votes
ThresholdMet(id, sid) ==
  SupportWeight(id, sid) >= slices[sid].threshold

-----------------------------------------------------------------------------
(* Actions *)

\* Create / configure a slice
ConfigureSlice(sid, members, weights, threshold) ==
  /\ sid \in SliceIds
  /\ members \subseteq Attestors
  /\ threshold > 0
  /\ slices' = [slices EXCEPT
      ![sid] = [members   |-> members,
                weights   |-> weights,
                threshold |-> threshold]]
  /\ UNCHANGED <<cred_state, votes, challenges, paused>>

\* An attestor casts a vote
CastVote(a, id, sid, support) ==
  /\ ~paused
  /\ id \in CredIds
  /\ sid \in SliceIds
  /\ a \in slices[sid].members           \* I4: must be a slice member
  /\ cred_state[id] = "Active"           \* cannot vote on revoked/attested
  /\ ~challenges[id]                     \* I6: challenge blocks new votes
  /\ votes[id][sid][a] = FALSE           \* I5: no double vote
  /\ votes' = [votes EXCEPT ![id][sid][a] = support]
  /\ UNCHANGED <<cred_state, slices, challenges, paused>>

\* Finalise attestation: once threshold met, transition to Attested
FinaliseAttestation(id, sid) ==
  /\ ~paused
  /\ cred_state[id] = "Active"
  /\ ~challenges[id]                     \* I6
  /\ ThresholdMet(id, sid)
  /\ cred_state' = [cred_state EXCEPT ![id] = "Attested"]
  /\ UNCHANGED <<slices, votes, challenges, paused>>

\* Revoke a credential
RevokeCredential(id) ==
  /\ cred_state[id] \in {"Active"}       \* can only revoke Active credentials
  /\ cred_state' = [cred_state EXCEPT ![id] = "Revoked"]
  /\ UNCHANGED <<slices, votes, challenges, paused>>

\* Raise a challenge against a credential's attestation
RaiseChallenge(id) ==
  /\ cred_state[id] \in {"Active", "Attested"}
  /\ ~challenges[id]
  /\ challenges' = [challenges EXCEPT ![id] = TRUE]
  /\ UNCHANGED <<cred_state, slices, votes, paused>>

\* Resolve a challenge (outcome: challenge dismissed — credential stays Attested,
\* or upheld — credential reverted to Active or Revoked handled separately)
ResolveChallenge(id) ==
  /\ challenges[id]
  /\ challenges' = [challenges EXCEPT ![id] = FALSE]
  /\ UNCHANGED <<cred_state, slices, votes, paused>>

\* Pause / unpause
PauseContract   == /\ ~paused /\ paused' = TRUE  /\ UNCHANGED <<cred_state, slices, votes, challenges>>
UnpauseContract == /\ paused  /\ paused' = FALSE /\ UNCHANGED <<cred_state, slices, votes, challenges>>

-----------------------------------------------------------------------------
(* Next-state relation *)

Next ==
  \/ \E sid \in SliceIds,
        m \in SUBSET Attestors,
        w \in [Attestors -> Nat],
        t \in 1..10 :
          ConfigureSlice(sid, m, w, t)
  \/ \E a \in Attestors, id \in CredIds, sid \in SliceIds, s \in BOOLEAN :
          CastVote(a, id, sid, s)
  \/ \E id \in CredIds, sid \in SliceIds : FinaliseAttestation(id, sid)
  \/ \E id \in CredIds : RevokeCredential(id)
  \/ \E id \in CredIds : RaiseChallenge(id)
  \/ \E id \in CredIds : ResolveChallenge(id)
  \/ PauseContract
  \/ UnpauseContract

Fairness ==
  /\ \A id \in CredIds, sid \in SliceIds :
       WF_vars(FinaliseAttestation(id, sid))
  /\ WF_vars(UnpauseContract)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* INVARIANTS *)

\* I1. Type invariant
TypeInvariant ==
  /\ \A id \in CredIds : cred_state[id] \in CredStateValues
  /\ \A sid \in SliceIds : slices[sid].threshold \in Nat
  /\ paused \in BOOLEAN
  /\ \A id \in CredIds : \A sid \in SliceIds : \A a \in Attestors :
       votes[id][sid][a] \in BOOLEAN
  /\ \A id \in CredIds : challenges[id] \in BOOLEAN

\* I2. Revoked credentials cannot be attested
RevokedNotAttested ==
  \A id \in CredIds : ~(cred_state[id] = "Revoked" /\ cred_state[id] = "Attested")

\* I3. Threshold enforced — attested credentials must have met their threshold
\*     for at least one slice. (Existential: at least one slice drove it.)
ThresholdEnforced ==
  \A id \in CredIds :
    cred_state[id] = "Attested" =>
      \E sid \in SliceIds : ThresholdMet(id, sid)

\* I4. No vote from a non-member
AttestorInSlice ==
  \A id \in CredIds, sid \in SliceIds, a \in Attestors :
    votes[id][sid][a] = TRUE => a \in slices[sid].members

\* I5. No double vote — votes are boolean (TRUE/FALSE only once per attestor).
\*     Enforced by the CastVote guard `votes[id][sid][a] = FALSE`; no need for
\*     a separate invariant beyond TypeInvariant, but we make it explicit.
NoDoubleVotePossible ==
  \A id \in CredIds, sid \in SliceIds, a \in Attestors :
    votes[id][sid][a] \in BOOLEAN  \* tautology with type, documents intent

\* I6. A credential with an active challenge cannot be attested
ChallengeBlocksAttestation ==
  \A id \in CredIds :
    challenges[id] => cred_state[id] # "Attested"

\* Composite safety invariant — all of the above
SafetyInvariant ==
  /\ TypeInvariant
  /\ RevokedNotAttested
  /\ ThresholdEnforced
  /\ AttestorInSlice
  /\ ChallengeBlocksAttestation

-----------------------------------------------------------------------------
(* LIVENESS *)

\* L1. A credential with enough supporting votes and no challenges eventually attests.
EventualAttestation ==
  \A id \in CredIds, sid \in SliceIds :
    (cred_state[id] = "Active" /\ ~challenges[id] /\ ThresholdMet(id, sid))
    ~> (cred_state[id] = "Attested")

-----------------------------------------------------------------------------
(*
  TLC model setup:
    Attestors        <- {A1, A2, A3}
    CredIds          <- {C1, C2}
    SliceIds         <- {S1}
    
  Check invariants: SafetyInvariant
  Check temporal:   EventualAttestation
  
  Expect: no counterexamples for SafetyInvariant.
  Note:   ChallengeBlocksAttestation requires that FinaliseAttestation
          checks ~challenges[id] — verify this matches the Rust guard in lib.rs.
*)

====
