export const graphqlSchema = `
type Query {
  credential(id: ID!): Credential
  credentials(ids: [ID!]!): [Credential]
  credentialsByIssuer(issuer: String!, limit: Int, offset: Int): CredentialConnection
  credentialsByHolder(holder: String!, limit: Int, offset: Int): CredentialConnection
  slice(id: ID!): Slice
  credentialCount: Int!
  attestorReputation(address: String!): AttestorReputation
  credentialTier(credentialId: ID!): CredentialTier
  credentialRewards(credentialId: ID!, status: String): [Reward]
  rewardsSummary(credentialId: ID!): RewardSummary
  searchCredentials(query: String!, limit: Int, offset: Int): CredentialSearchResults
  tierStats: [TierStatistic]!
}

type Mutation {
  updateCredentialReputation(credentialId: ID!, scoreIncrement: Int!): CredentialTier
  claimReward(credentialId: ID!, rewardId: ID!): RewardEscrow
  settleEscrow(escrowId: ID!, settlementHash: String!): RewardEscrow
}

type Credential {
  id: ID!
  type: String
  subject: String
  issuer: String
  holder: String
  issuanceDate: String
  expirationDate: String
  revoked: Boolean
  suspended: Boolean
  metadata: String
  version: Int
  tier: CredentialTier
  rewards: [Reward]
}

type CredentialConnection {
  edges: [CredentialEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type CredentialEdge {
  node: Credential!
  cursor: String!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

type Slice {
  id: ID!
  validators: [String!]!
  quorumThreshold: Int
  created: String
}

type AttestorReputation {
  address: String!
  score: Int!
}

type CredentialTier {
  credentialId: ID!
  tier: String!
  reputationScore: Int!
  createdAt: String!
  updatedAt: String!
  promotedAt: String
}

type Reward {
  id: ID!
  credentialId: ID!
  tier: String!
  amount: String!
  status: String!
  earnedAt: String!
  expiresAt: String!
  claimedAt: String
  createdAt: String!
}

type RewardEscrow {
  id: ID!
  credentialId: ID!
  rewardId: ID!
  amount: String!
  status: String!
  heldUntil: String!
  settledAt: String
  settlementHash: String
  createdAt: String!
}

type RewardSummary {
  total: String!
  claimed: String!
  pending: String!
}

type CredentialSearchResults {
  results: [Credential!]!
  totalCount: Int!
  hasMore: Boolean!
}

type TierStatistic {
  tier: String!
  count: Int!
  avgReputation: Int!
}
`;

export const federatedSchema = `
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.0")

type Credential @key(fields: "id") {
  id: ID! @external
  __typename: String!
}

type CredentialTier @key(fields: "credentialId") {
  credentialId: ID! @external
  __typename: String!
}

type AttestorReputation @key(fields: "address") {
  address: String! @external
  __typename: String!
}
`;
