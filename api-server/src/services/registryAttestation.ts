import { createHash, randomBytes, sign as cryptoSign, verify as cryptoVerify, timingSafeEqual } from 'crypto';

/**
 * Registry attestation proof mechanism for government-licensing issuers.
 * See docs/adr/adr-005-registry-attestation-proof.md for the design rationale.
 *
 * Tiers (never silently substituted for one another — every proof object
 * carries its own `proofTier`):
 *   - 'zktls-v1'          reserved for a future MPC-TLS proof; not implemented here.
 *   - 'oracle-committee'  default: m-of-n independently signed registry fetches.
 *   - 'single-attester'   explicit fallback for registries that cannot support
 *                         multi-party fetching (e.g. IP-allowlisted APIs).
 *   - 'legacy-unproven'   pre-existing v1 metadata hash, no registry proof at all.
 */

export type ProofTier = 'zktls-v1' | 'oracle-committee' | 'single-attester' | 'legacy-unproven';

const TIER_RANK: Record<ProofTier, number> = {
  'legacy-unproven': 0,
  'single-attester': 1,
  'oracle-committee': 2,
  'zktls-v1': 3,
};

export class RegistryQuorumError extends Error {}
export class RegistryProofStaleError extends Error {
  constructor(public readonly ageSeconds: number, public readonly maxAgeSeconds: number) {
    super(`Registry proof is ${ageSeconds}s old, exceeds freshness policy of ${maxAgeSeconds}s`);
  }
}
export class InsufficientProofTierError extends Error {
  constructor(public readonly actualTier: ProofTier, public readonly requiredTier: ProofTier) {
    super(`Registry proof tier '${actualTier}' does not meet required minimum tier '${requiredTier}'`);
  }
}

// ---------------------------------------------------------------------------
// Canonicalization & hashing
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively, arrays preserve order. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Hash a registry response body for cross-oracle comparison. If the body is
 * JSON, canonicalize it first so whitespace/key-order noise between two
 * independent fetchers of the same logical record doesn't look like tamper.
 * Non-JSON bodies (or malformed JSON) hash the raw bytes.
 */
export function canonicalResponseBodyHash(responseBody: string): string {
  try {
    return sha256Hex(canonicalize(JSON.parse(responseBody)));
  } catch {
    return sha256Hex(responseBody);
  }
}

// ---------------------------------------------------------------------------
// Registry Fetch Attestation (single oracle's signed record of one fetch)
// ---------------------------------------------------------------------------

export interface OracleIdentity {
  oracleId: string;
  /** SPKI PEM-encoded Ed25519 public key. */
  publicKeyPem: string;
}

export interface RegistryFetchAttestationInput {
  oracleId: string;
  registryUrl: string;
  requestMethod: string;
  /** Non-secret request headers only (e.g. Accept) — never API keys. */
  requestHeaders?: Record<string, string>;
  responseStatus: number;
  responseBody: string;
  /** SHA-256 fingerprint (hex) of the leaf TLS certificate the registry presented. */
  tlsCertFingerprint: string;
  tlsCertNotAfter: string;
  fetchedAt: string;
  nonce?: string;
}

export interface RegistryFetchAttestation {
  version: 1;
  oracleId: string;
  registryUrl: string;
  requestMethod: string;
  requestHeadersHash: string;
  responseStatus: number;
  responseBodyHash: string;
  responseBodyCanonicalHash: string;
  tlsCertFingerprint: string;
  tlsCertNotAfter: string;
  fetchedAt: string;
  nonce: string;
  signature: string;
}

function attestationSigningPayload(a: Omit<RegistryFetchAttestation, 'signature'>): string {
  return canonicalize(a);
}

export function signRegistryFetchAttestation(
  input: RegistryFetchAttestationInput,
  oraclePrivateKeyPem: string
): RegistryFetchAttestation {
  const unsigned: Omit<RegistryFetchAttestation, 'signature'> = {
    version: 1,
    oracleId: input.oracleId,
    registryUrl: input.registryUrl,
    requestMethod: input.requestMethod,
    requestHeadersHash: sha256Hex(canonicalize(input.requestHeaders ?? {})),
    responseStatus: input.responseStatus,
    responseBodyHash: sha256Hex(input.responseBody),
    responseBodyCanonicalHash: canonicalResponseBodyHash(input.responseBody),
    tlsCertFingerprint: input.tlsCertFingerprint,
    tlsCertNotAfter: input.tlsCertNotAfter,
    fetchedAt: input.fetchedAt,
    nonce: input.nonce ?? randomBytes(16).toString('hex'),
  };

  const signature = cryptoSign(null, Buffer.from(attestationSigningPayload(unsigned)), oraclePrivateKeyPem).toString('hex');
  return { ...unsigned, signature };
}

/** Recomputes the signature independently — does not trust any field on `a` at face value. */
export function verifyAttestationSignature(a: RegistryFetchAttestation, oraclePublicKeyPem: string): boolean {
  const { signature, ...unsigned } = a;
  try {
    const sigBuf = Buffer.from(signature, 'hex');
    return cryptoVerify(null, Buffer.from(attestationSigningPayload(unsigned)), oraclePublicKeyPem, sigBuf);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Freshness policy
// ---------------------------------------------------------------------------

export interface FreshnessPolicy {
  maxAgeSeconds: number;
}

export function checkFreshness(fetchedAtIso: string, policy: FreshnessPolicy, asOf: Date = new Date()): void {
  const fetchedAt = new Date(fetchedAtIso);
  if (Number.isNaN(fetchedAt.getTime())) {
    throw new RegistryProofStaleError(Number.POSITIVE_INFINITY, policy.maxAgeSeconds);
  }
  const ageSeconds = Math.max(0, (asOf.getTime() - fetchedAt.getTime()) / 1000);
  if (ageSeconds > policy.maxAgeSeconds) {
    throw new RegistryProofStaleError(Math.round(ageSeconds), policy.maxAgeSeconds);
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — Registry Attestation Quorum (oracle committee)
// ---------------------------------------------------------------------------

export interface RegistryAttestationQuorum {
  version: 1;
  proofTier: 'oracle-committee';
  registryUrl: string;
  responseBodyCanonicalHash: string;
  threshold: number;
  totalOracles: number;
  attestations: RegistryFetchAttestation[];
  earliestFetchedAt: string;
  quorumFormedAt: string;
}

/**
 * Forms a quorum from raw attestations. Any attestation with an invalid
 * signature, an unregistered oracleId, or a duplicate oracleId is discarded.
 * Of what remains, attestations are grouped by (registryUrl, canonical
 * response hash); the largest agreeing group must meet `threshold` or
 * formation fails — a minority of tampered/disagreeing attestations cannot
 * poison a legitimate quorum, but also cannot inflate one below threshold.
 */
export function formRegistryAttestationQuorum(
  attestations: RegistryFetchAttestation[],
  oracleRegistry: OracleIdentity[],
  threshold: number,
  asOf: Date = new Date()
): RegistryAttestationQuorum {
  const knownOracles = new Map(oracleRegistry.map((o) => [o.oracleId, o.publicKeyPem]));
  const seenOracleIds = new Set<string>();
  const valid: RegistryFetchAttestation[] = [];

  for (const a of attestations) {
    const pubKey = knownOracles.get(a.oracleId);
    if (!pubKey) continue; // unregistered oracle — reject
    if (seenOracleIds.has(a.oracleId)) continue; // duplicate — only first counts, reject extras
    if (!verifyAttestationSignature(a, pubKey)) continue; // tampered or forged — reject
    seenOracleIds.add(a.oracleId);
    valid.push(a);
  }

  const groups = new Map<string, RegistryFetchAttestation[]>();
  for (const a of valid) {
    const key = `${a.registryUrl} ${a.responseBodyCanonicalHash}`;
    const group = groups.get(key) ?? [];
    group.push(a);
    groups.set(key, group);
  }

  let bestGroup: RegistryFetchAttestation[] = [];
  for (const group of groups.values()) {
    if (group.length > bestGroup.length) bestGroup = group;
  }

  if (bestGroup.length < threshold) {
    throw new RegistryQuorumError(
      `Only ${bestGroup.length} of ${attestations.length} attestations were valid and in agreement; threshold is ${threshold}`
    );
  }

  const earliestFetchedAt = bestGroup
    .map((a) => a.fetchedAt)
    .sort()[0];

  return {
    version: 1,
    proofTier: 'oracle-committee',
    registryUrl: bestGroup[0].registryUrl,
    responseBodyCanonicalHash: bestGroup[0].responseBodyCanonicalHash,
    threshold,
    totalOracles: oracleRegistry.length,
    attestations: bestGroup,
    earliestFetchedAt,
    quorumFormedAt: asOf.toISOString(),
  };
}

/**
 * Independent re-verification of an already-formed quorum: a third party
 * (with no involvement in forming it) recomputes every signature and the
 * agreement/threshold logic from scratch. Throws on any tamper.
 */
export function verifyRegistryAttestationQuorum(
  raq: RegistryAttestationQuorum,
  oracleRegistry: OracleIdentity[]
): void {
  if (raq.attestations.length < raq.threshold) {
    throw new RegistryQuorumError('Quorum bundle contains fewer attestations than its declared threshold');
  }

  const knownOracles = new Map(oracleRegistry.map((o) => [o.oracleId, o.publicKeyPem]));
  const seenOracleIds = new Set<string>();

  for (const a of raq.attestations) {
    const pubKey = knownOracles.get(a.oracleId);
    if (!pubKey) throw new RegistryQuorumError(`Attestation from unregistered oracle '${a.oracleId}'`);
    if (seenOracleIds.has(a.oracleId)) throw new RegistryQuorumError(`Duplicate attestation from oracle '${a.oracleId}'`);
    if (!verifyAttestationSignature(a, pubKey)) throw new RegistryQuorumError(`Invalid signature from oracle '${a.oracleId}' — tamper detected`);
    if (a.registryUrl !== raq.registryUrl || a.responseBodyCanonicalHash !== raq.responseBodyCanonicalHash) {
      throw new RegistryQuorumError(`Attestation from oracle '${a.oracleId}' does not agree with the quorum's declared response`);
    }
    seenOracleIds.add(a.oracleId);
  }
}

// ---------------------------------------------------------------------------
// Tier 3 — Single-attester fallback (explicit, no silent downgrade)
// ---------------------------------------------------------------------------

export interface SingleAttesterProof {
  proofTier: 'single-attester';
  attesterId: string;
  attestation: RegistryFetchAttestation;
}

export function buildSingleAttesterProof(
  input: RegistryFetchAttestationInput,
  attesterId: string,
  attesterPrivateKeyPem: string
): SingleAttesterProof {
  return {
    proofTier: 'single-attester',
    attesterId,
    attestation: signRegistryFetchAttestation({ ...input, oracleId: attesterId }, attesterPrivateKeyPem),
  };
}

export function verifySingleAttesterProof(proof: SingleAttesterProof, attesterPublicKeyPem: string): void {
  if (proof.attestation.oracleId !== proof.attesterId) {
    throw new RegistryQuorumError('Single-attester proof attesterId does not match the attestation oracleId');
  }
  if (!verifyAttestationSignature(proof.attestation, attesterPublicKeyPem)) {
    throw new RegistryQuorumError(`Invalid signature from attester '${proof.attesterId}' — tamper detected`);
  }
}

// ---------------------------------------------------------------------------
// Unified proof envelope
// ---------------------------------------------------------------------------

export type RegistryProof =
  | { proofTier: 'oracle-committee'; quorum: RegistryAttestationQuorum }
  | SingleAttesterProof
  | { proofTier: 'legacy-unproven' };

export interface TrustLevelDescription {
  proofTier: ProofTier;
  reducedAssurance: boolean;
  label: string;
}

const TIER_LABELS: Record<ProofTier, string> = {
  'zktls-v1': 'MPC-TLS proof of the raw TLS session (highest assurance)',
  'oracle-committee': 'Independently corroborated by a threshold of registry-fetch oracles',
  'single-attester': 'REDUCED ASSURANCE — single signed fetch, no independent corroboration',
  'legacy-unproven': 'UNPROVEN — legacy credential with no registry fetch proof at all',
};

/** Always reflects the proof's real tier — never relabels a lower tier as a higher one. */
export function describeTrustLevel(proof: RegistryProof): TrustLevelDescription {
  const proofTier = proof.proofTier;
  return {
    proofTier,
    reducedAssurance: TIER_RANK[proofTier] < TIER_RANK['oracle-committee'],
    label: TIER_LABELS[proofTier],
  };
}

/** Throws unless `proof` meets or exceeds `minimumTier`. Never silently accepts a lower tier. */
export function assertMinimumTier(proof: RegistryProof, minimumTier: ProofTier): void {
  if (TIER_RANK[proof.proofTier] < TIER_RANK[minimumTier]) {
    throw new InsufficientProofTierError(proof.proofTier, minimumTier);
  }
}

/** Freshness bound to the earliest fetch actually backing the proof. Legacy proofs have none. */
export function checkProofFreshness(proof: RegistryProof, policy: FreshnessPolicy, asOf: Date = new Date()): void {
  if (proof.proofTier === 'oracle-committee') {
    checkFreshness(proof.quorum.earliestFetchedAt, policy, asOf);
  } else if (proof.proofTier === 'single-attester') {
    checkFreshness(proof.attestation.fetchedAt, policy, asOf);
  } else {
    throw new RegistryProofStaleError(Number.POSITIVE_INFINITY, policy.maxAgeSeconds);
  }
}

/** Independent re-verification of a proof's internal integrity (signatures/agreement), tier-dispatched. */
export function verifyRegistryProof(proof: RegistryProof, oracleRegistry: OracleIdentity[]): void {
  if (proof.proofTier === 'oracle-committee') {
    verifyRegistryAttestationQuorum(proof.quorum, oracleRegistry);
  } else if (proof.proofTier === 'single-attester') {
    const pubKey = oracleRegistry.find((o) => o.oracleId === proof.attesterId)?.publicKeyPem;
    if (!pubKey) throw new RegistryQuorumError(`Attester '${proof.attesterId}' is not a registered identity`);
    verifySingleAttesterProof(proof, pubKey);
  }
  // 'legacy-unproven' has nothing to verify by construction.
}

// ---------------------------------------------------------------------------
// Metadata document construction & on-chain binding
// ---------------------------------------------------------------------------

export interface LegacyMetadataFields {
  permitNumber: string;
  registryUrl: string;
  issuedDate: string;
}

/** Matches the original (pre-proof) reference implementation, kept for legacy verification. */
export function buildMetadataHashV1(fields: LegacyMetadataFields): Buffer {
  return createHash('sha256').update(JSON.stringify(fields)).digest();
}

export interface MetadataDocumentV2 extends LegacyMetadataFields {
  schemaVersion: 2;
  registryProof: RegistryProof;
}

export function buildMetadataDocumentV2(fields: LegacyMetadataFields, registryProof: RegistryProof): MetadataDocumentV2 {
  return { schemaVersion: 2, ...fields, registryProof };
}

/** This is what goes on-chain as `metadata_hash` — a content address of the full document. */
export function hashMetadataDocument(doc: MetadataDocumentV2 | LegacyMetadataFields): Buffer {
  return createHash('sha256').update(canonicalize(doc)).digest();
}

/** Recomputes the content hash and compares against the on-chain value in constant time. */
export function verifyMetadataHashBinding(
  onChainMetadataHash: Buffer,
  doc: MetadataDocumentV2 | LegacyMetadataFields
): boolean {
  const recomputed = hashMetadataDocument(doc);
  if (recomputed.length !== onChainMetadataHash.length) return false;
  return timingSafeEqual(recomputed, onChainMetadataHash);
}

// ---------------------------------------------------------------------------
// Content-addressed document store (off-chain publication so a verifier can
// fetch the full document a `metadata_hash` points to and re-verify it).
// ---------------------------------------------------------------------------

export class RegistryProofStore {
  private documents = new Map<string, MetadataDocumentV2 | LegacyMetadataFields>();

  /** Publishes a document and returns its content address (hex), matching `metadata_hash`. */
  publish(doc: MetadataDocumentV2 | LegacyMetadataFields): string {
    const hash = hashMetadataDocument(doc).toString('hex');
    this.documents.set(hash, doc);
    return hash;
  }

  fetch(contentHash: string): MetadataDocumentV2 | LegacyMetadataFields | undefined {
    return this.documents.get(contentHash);
  }
}
