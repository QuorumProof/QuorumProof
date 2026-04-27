# ADR-0002: Soulbound Tokens (SBTs) for Non-Transferable Credentials

## Status
Accepted

## Context
Professional credentials should not be tradeable or transferable — they represent personal qualifications tied to an individual. The challenge: how to represent credentials on-chain in a way that prevents unauthorized transfer while remaining verifiable.

## Decision
Implement Soulbound Tokens (SBTs) — non-transferable tokens locked to a Stellar account that represent professional credentials. SBTs cannot be transferred, sold, or delegated, ensuring credentials remain bound to the original holder.

## Rationale
- **Authenticity**: Credentials cannot be sold or spoofed by third parties
- **Accountability**: Credentials remain tied to the individual who earned them
- **Simplicity**: Non-transferability is enforced at the contract level
- **Alignment**: Matches real-world credential semantics (you can't transfer your degree)

## Alternatives Considered
- **Transferable Tokens**: Standard ERC-20 style tokens
  - Tradeoff: More flexible, but credentials could be bought/sold, defeating their purpose
  
- **Revocation Registry**: Transferable tokens with a separate revocation list
  - Tradeoff: More complex, still allows credential trading before revocation
  
- **Delegation Model**: Allow temporary delegation of credentials
  - Tradeoff: Adds complexity, potential for abuse

## Consequences
### Positive
- Credentials cannot be fraudulently transferred
- Clear ownership semantics
- Prevents credential market abuse
- Simpler contract logic

### Negative
- Lost private keys mean lost credentials (no recovery mechanism)
- Cannot delegate credentials to representatives
- Requires careful key management by users

## References
- [Soulbound Tokens: Identifying and Allocating Decentralized Society](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4105763)
- [SBT Registry Contract](../../contracts/sbt_registry/src/lib.rs)
