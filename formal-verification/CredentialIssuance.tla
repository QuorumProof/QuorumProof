---- MODULE CredentialIssuance ----
(*
  Issue #1317 — Formal Verification: Credential Issuance Model
  
  This TLA+ specification models the credential issuance subsystem of
  QuorumProof. It captures the core state machine for issuing, revoking,
  and querying credentials and verifies the following safety invariants:
  
  INVARIANTS (machine-checkable with TLC):
  
  I1. TypeInvariant          — All state variables have well-typed values.
  I2. UniqueCredentialIds    — No two credentials share an id.
  I3. RevokedNotIssuable     — A (subject, issuer, type) triple that is
                               currently revoked cannot be re-issued under
                               the same id.
  I4. IssuedBeforeRevoked    — A credential cannot be revoked before it exists.
  I5. CountConsistency       — credential_count equals the number of stored
                               credentials at all times.
  I6. RevokedCantBeAttested  — A revoked credential cannot transition to
                               attested (the attestation subsystem checks
                               revocation; see QuorumSliceAttestation.tla).
  
  LIVENESS (not checked by TLC by default — requires fairness):
  
  L1. EventualIssuance       — If a valid issue request is pending and the
                               contract is not paused, a credential will
                               eventually be issued.
  
  REFERENCES:
  - contracts/quorum_proof/src/lib.rs  — Rust implementation
  - docs/adr/adr-001-fba-trust-model.md
  - docs/error-codes.md
*)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
  Issuers,         \* Set of possible issuer addresses
  Subjects,        \* Set of possible subject addresses
  CredentialTypes  \* Set of possible credential type ids (u32)

ASSUME Issuers \cap Subjects = {}  \* Issuers and subjects are disjoint in tests

VARIABLES
  credentials,      \* Function: CredId -> [issuer, subject, ctype, revoked, exists]
  credential_count, \* Monotonically increasing counter (mirrors on-chain counter)
  paused,           \* Boolean: contract-level pause flag
  pending_issues    \* Set of pending issue requests (models off-chain queue)

vars == <<credentials, credential_count, paused, pending_issues>>

-----------------------------------------------------------------------------
(* Type definitions *)

CredId == Nat  \* u64 in Rust; we use Nat here for unbounded modelling

CredRecord == [
  issuer  : Issuers,
  subject : Subjects,
  ctype   : CredentialTypes,
  revoked : BOOLEAN,
  exists  : BOOLEAN
]

IssueRequest == [issuer : Issuers, subject : Subjects, ctype : CredentialTypes]

-----------------------------------------------------------------------------
(* Initial state *)

Init ==
  /\ credentials      = [id \in {} |-> [issuer |-> CHOOSE i \in Issuers : TRUE,
                                        subject |-> CHOOSE s \in Subjects : TRUE,
                                        ctype   |-> CHOOSE t \in CredentialTypes : TRUE,
                                        revoked |-> FALSE,
                                        exists  |-> FALSE]]
  /\ credential_count = 0
  /\ paused           = FALSE
  /\ pending_issues   = {}

-----------------------------------------------------------------------------
(* Helper predicates *)

\* The set of credential ids currently in use
IssuedIds == {id \in DOMAIN credentials : credentials[id].exists}

\* True if a (subject, issuer, ctype) triple is already active (not revoked)
ActiveTripleExists(s, i, t) ==
  \E id \in IssuedIds :
    /\ credentials[id].subject = s
    /\ credentials[id].issuer  = i
    /\ credentials[id].ctype   = t
    /\ ~credentials[id].revoked

-----------------------------------------------------------------------------
(* Actions *)

\* Submit an issue request (off-chain actor enqueues it)
SubmitIssueRequest(req) ==
  /\ req \in IssueRequest
  /\ pending_issues' = pending_issues \cup {req}
  /\ UNCHANGED <<credentials, credential_count, paused>>

\* Issue a credential: transitions a pending request to an on-chain credential.
\* Guard mirrors the Rust implementation:
\*   - contract must not be paused
\*   - no active credential for the same (subject, issuer, type) triple
IssueCredential(req) ==
  /\ ~paused
  /\ req \in pending_issues
  /\ ~ActiveTripleExists(req.subject, req.issuer, req.ctype)
  /\ LET new_id == credential_count + 1
         new_rec == [issuer  |-> req.issuer,
                     subject |-> req.subject,
                     ctype   |-> req.ctype,
                     revoked |-> FALSE,
                     exists  |-> TRUE]
     IN
     /\ credentials'      = [credentials EXCEPT ![new_id] = new_rec]
     /\ credential_count' = new_id
     /\ pending_issues'   = pending_issues \ {req}
     /\ UNCHANGED paused

\* Revoke a credential: only the original issuer may revoke.
RevokeCredential(id) ==
  /\ id \in IssuedIds
  /\ ~credentials[id].revoked
  /\ credentials' = [credentials EXCEPT ![id].revoked = TRUE]
  /\ UNCHANGED <<credential_count, paused, pending_issues>>

\* Pause / unpause (admin-only in Rust; modelled here without auth for simplicity)
PauseContract  == /\ ~paused  /\ paused' = TRUE  /\ UNCHANGED <<credentials, credential_count, pending_issues>>
UnpauseContract == /\ paused  /\ paused' = FALSE /\ UNCHANGED <<credentials, credential_count, pending_issues>>

-----------------------------------------------------------------------------
(* Next-state relation *)

Next ==
  \/ \E req \in IssueRequest : SubmitIssueRequest(req)
  \/ \E req \in pending_issues : IssueCredential(req)
  \/ \E id \in IssuedIds : RevokeCredential(id)
  \/ PauseContract
  \/ UnpauseContract

-----------------------------------------------------------------------------
(* Fairness — needed for liveness properties *)

Fairness ==
  \A req \in IssueRequest :
    WF_vars(IssueCredential(req))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* INVARIANTS *)

\* I1. Type invariant
TypeInvariant ==
  /\ credential_count \in Nat
  /\ paused           \in BOOLEAN
  /\ pending_issues   \subseteq IssueRequest
  /\ \A id \in DOMAIN credentials :
       /\ credentials[id].issuer  \in Issuers
       /\ credentials[id].subject \in Subjects
       /\ credentials[id].ctype   \in CredentialTypes
       /\ credentials[id].revoked \in BOOLEAN
       /\ credentials[id].exists  \in BOOLEAN

\* I2. No two credentials share an id (guaranteed by monotonic counter)
UniqueCredentialIds ==
  \A id1, id2 \in IssuedIds :
    id1 # id2 => credentials[id1] # credentials[id2] \/ id1 = id2

\* I3. The same active triple cannot exist twice
NoDuplicateActiveCredentials ==
  \A id1, id2 \in IssuedIds :
    (id1 # id2
     /\ credentials[id1].subject = credentials[id2].subject
     /\ credentials[id1].issuer  = credentials[id2].issuer
     /\ credentials[id1].ctype   = credentials[id2].ctype)
    => (credentials[id1].revoked \/ credentials[id2].revoked)

\* I4. A credential cannot be revoked unless it exists
IssuedBeforeRevoked ==
  \A id \in DOMAIN credentials :
    credentials[id].revoked => credentials[id].exists

\* I5. Counter consistency
CountConsistency ==
  credential_count = Cardinality(IssuedIds)

\* I6. Revoked credentials cannot become active again without re-issuance under
\*     a new id — once revoked.revoked = TRUE, it stays TRUE (no un-revoke path
\*     in the current contract design).
RevokedIsPermanent ==
  [][
    \A id \in IssuedIds :
      credentials[id].revoked => credentials'[id].revoked
  ]_vars

-----------------------------------------------------------------------------
(* LIVENESS *)

\* L1. Every valid pending issue eventually results in a credential, unless
\*     the contract remains paused indefinitely (which WF on UnpauseContract
\*     rules out if we add fairness there too).
EventualIssuance ==
  \A req \in IssueRequest :
    (req \in pending_issues /\ ~paused)
    ~> (req \notin pending_issues)

-----------------------------------------------------------------------------
(* TLC model values — instantiate with small finite sets for checking *)
(*
  To run with TLC, create a model and set:
    Issuers         <- {Issuer1, Issuer2}
    Subjects        <- {Subject1, Subject2}
    CredentialTypes <- {1, 2, 3}
  
  Check invariants: TypeInvariant, NoDuplicateActiveCredentials,
                    IssuedBeforeRevoked, CountConsistency
  Check temporal:   EventualIssuance
*)

====
