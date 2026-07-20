import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  signRegistryFetchAttestation,
  verifyAttestationSignature,
  formRegistryAttestationQuorum,
  verifyRegistryAttestationQuorum,
  buildSingleAttesterProof,
  verifySingleAttesterProof,
  verifyRegistryProof,
  checkFreshness,
  checkProofFreshness,
  buildMetadataHashV1,
  buildMetadataDocumentV2,
  hashMetadataDocument,
  verifyMetadataHashBinding,
  describeTrustLevel,
  assertMinimumTier,
  RegistryProofStore,
  RegistryQuorumError,
  RegistryProofStaleError,
  InsufficientProofTierError,
  type OracleIdentity,
  type RegistryFetchAttestationInput,
} from '../src/services/registryAttestation.js';

function makeOracle(oracleId: string): { identity: OracleIdentity; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    identity: { oracleId, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string },
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

const REGISTRY_URL = 'https://registry.example.gov/api/permits/PE-4471';
const RESPONSE_BODY = JSON.stringify({
  permitNumber: 'PE-4471',
  holderName: 'Ada Lovelace',
  licenceType: 'Professional Engineering Licence',
  issuedDate: '2020-03-01',
  expiryDate: null,
  status: 'active',
});

function fetchInput(overrides: Partial<RegistryFetchAttestationInput> = {}): RegistryFetchAttestationInput {
  return {
    oracleId: 'oracle-a',
    registryUrl: REGISTRY_URL,
    requestMethod: 'GET',
    requestHeaders: { Accept: 'application/json' },
    responseStatus: 200,
    responseBody: RESPONSE_BODY,
    tlsCertFingerprint: 'aa'.repeat(32),
    tlsCertNotAfter: '2027-01-01T00:00:00.000Z',
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('RegistryFetchAttestation signing', () => {
  it('produces a signature that verifies against the signer public key', () => {
    const oracle = makeOracle('oracle-a');
    const attestation = signRegistryFetchAttestation(fetchInput(), oracle.privateKeyPem);
    expect(verifyAttestationSignature(attestation, oracle.identity.publicKeyPem)).toBe(true);
  });

  it('rejects a signature verified against the wrong public key', () => {
    const oracle = makeOracle('oracle-a');
    const impostor = makeOracle('oracle-b');
    const attestation = signRegistryFetchAttestation(fetchInput(), oracle.privateKeyPem);
    expect(verifyAttestationSignature(attestation, impostor.identity.publicKeyPem)).toBe(false);
  });
});

describe('tamper detection', () => {
  it('detects a mutated response body hash after signing', () => {
    const oracle = makeOracle('oracle-a');
    const attestation = signRegistryFetchAttestation(fetchInput(), oracle.privateKeyPem);
    const tampered = { ...attestation, responseBodyHash: 'ff'.repeat(32) };
    expect(verifyAttestationSignature(tampered, oracle.identity.publicKeyPem)).toBe(false);
  });

  it('detects a flipped signature byte', () => {
    const oracle = makeOracle('oracle-a');
    const attestation = signRegistryFetchAttestation(fetchInput(), oracle.privateKeyPem);
    const sigBuf = Buffer.from(attestation.signature, 'hex');
    sigBuf[0] ^= 0xff;
    const tampered = { ...attestation, signature: sigBuf.toString('hex') };
    expect(verifyAttestationSignature(tampered, oracle.identity.publicKeyPem)).toBe(false);
  });

  it('excludes a tampered attestation from quorum formation and still succeeds if threshold is otherwise met', () => {
    const a = makeOracle('oracle-a');
    const b = makeOracle('oracle-b');
    const c = makeOracle('oracle-c');
    const registry = [a.identity, b.identity, c.identity];

    const attA = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-a' }), a.privateKeyPem);
    const attB = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-b' }), b.privateKeyPem);
    const attCRaw = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-c' }), c.privateKeyPem);
    const attC = { ...attCRaw, responseBodyHash: 'ff'.repeat(32) }; // tampered post-signing

    const quorum = formRegistryAttestationQuorum([attA, attB, attC], registry, 2);
    expect(quorum.attestations).toHaveLength(2);
    expect(quorum.attestations.map((x) => x.oracleId).sort()).toEqual(['oracle-a', 'oracle-b']);
  });

  it('fails quorum formation when tamper drops valid attestations below threshold', () => {
    const a = makeOracle('oracle-a');
    const b = makeOracle('oracle-b');
    const registry = [a.identity, b.identity];

    const attA = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-a' }), a.privateKeyPem);
    const attBRaw = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-b' }), b.privateKeyPem);
    const attB = { ...attBRaw, signature: 'ff'.repeat(64) };

    expect(() => formRegistryAttestationQuorum([attA, attB], registry, 2)).toThrow(RegistryQuorumError);
  });

  it('rejects attestations from unregistered oracles', () => {
    const a = makeOracle('oracle-a');
    const stranger = makeOracle('oracle-x');
    const attStranger = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-x' }), stranger.privateKeyPem);

    expect(() => formRegistryAttestationQuorum([attStranger], [a.identity], 1)).toThrow(RegistryQuorumError);
  });

  it('rejects duplicate attestations from the same oracle counting twice toward threshold', () => {
    const a = makeOracle('oracle-a');
    const att = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-a' }), a.privateKeyPem);

    expect(() => formRegistryAttestationQuorum([att, { ...att }], [a.identity], 2)).toThrow(RegistryQuorumError);
  });

  it('does not let a minority of disagreeing oracles (different response) form a quorum entry with the majority', () => {
    const a = makeOracle('oracle-a');
    const b = makeOracle('oracle-b');
    const c = makeOracle('oracle-c');
    const registry = [a.identity, b.identity, c.identity];

    const attA = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-a' }), a.privateKeyPem);
    const attB = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-b' }), b.privateKeyPem);
    const attC = signRegistryFetchAttestation(
      fetchInput({ oracleId: 'oracle-c', responseBody: JSON.stringify({ ...JSON.parse(RESPONSE_BODY), status: 'revoked' }) }),
      c.privateKeyPem
    );

    const quorum = formRegistryAttestationQuorum([attA, attB, attC], registry, 2);
    expect(quorum.attestations.map((x) => x.oracleId).sort()).toEqual(['oracle-a', 'oracle-b']);
  });

  it('independent re-verification detects post-formation tamper of a stored quorum bundle', () => {
    const a = makeOracle('oracle-a');
    const b = makeOracle('oracle-b');
    const registry = [a.identity, b.identity];
    const attA = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-a' }), a.privateKeyPem);
    const attB = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-b' }), b.privateKeyPem);
    const quorum = formRegistryAttestationQuorum([attA, attB], registry, 2);

    // Simulate storage tamper: someone edits a field on a stored attestation.
    const tamperedQuorum = {
      ...quorum,
      attestations: [quorum.attestations[0], { ...quorum.attestations[1], responseStatus: 500 }],
    };

    expect(() => verifyRegistryAttestationQuorum(tamperedQuorum, registry)).toThrow(RegistryQuorumError);
    expect(() => verifyRegistryAttestationQuorum(quorum, registry)).not.toThrow();
  });
});

describe('staleness rejection', () => {
  it('accepts a fetch within the freshness window', () => {
    const fetchedAt = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    expect(() => checkFreshness(fetchedAt, { maxAgeSeconds: 300 })).not.toThrow();
  });

  it('rejects a fetch older than the freshness window', () => {
    const fetchedAt = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 minutes ago
    expect(() => checkFreshness(fetchedAt, { maxAgeSeconds: 300 })).toThrow(RegistryProofStaleError);
  });

  it('rejects an unparseable timestamp as stale', () => {
    expect(() => checkFreshness('not-a-date', { maxAgeSeconds: 300 })).toThrow(RegistryProofStaleError);
  });

  it('checks proof freshness against the oldest attestation in a quorum, not formation time', () => {
    const a = makeOracle('oracle-a');
    const b = makeOracle('oracle-b');
    const registry = [a.identity, b.identity];

    const staleFetchedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const attA = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-a', fetchedAt: staleFetchedAt }), a.privateKeyPem);
    const attB = signRegistryFetchAttestation(fetchInput({ oracleId: 'oracle-b' }), b.privateKeyPem);
    const quorum = formRegistryAttestationQuorum([attA, attB], registry, 2);

    expect(quorum.earliestFetchedAt).toBe(staleFetchedAt);
    expect(() => checkProofFreshness({ proofTier: 'oracle-committee', quorum }, { maxAgeSeconds: 300 })).toThrow(RegistryProofStaleError);
  });

  it('legacy-unproven proofs always fail freshness checks (no timestamp exists to check)', () => {
    expect(() => checkProofFreshness({ proofTier: 'legacy-unproven' }, { maxAgeSeconds: 300 })).toThrow(RegistryProofStaleError);
  });
});

describe('single-attester fallback tier (explicit, no silent downgrade)', () => {
  it('is always labeled single-attester and flagged as reduced assurance', () => {
    const attester = makeOracle('registrar-solo');
    const proof = buildSingleAttesterProof(fetchInput({ oracleId: 'registrar-solo' }), 'registrar-solo', attester.privateKeyPem);

    expect(proof.proofTier).toBe('single-attester');
    const trust = describeTrustLevel(proof);
    expect(trust.reducedAssurance).toBe(true);
    expect(trust.label).toMatch(/REDUCED ASSURANCE/);
  });

  it('verifies a genuine single-attester proof and rejects a tampered one', () => {
    const attester = makeOracle('registrar-solo');
    const proof = buildSingleAttesterProof(fetchInput({ oracleId: 'registrar-solo' }), 'registrar-solo', attester.privateKeyPem);
    expect(() => verifySingleAttesterProof(proof, attester.identity.publicKeyPem)).not.toThrow();

    const tampered = { ...proof, attestation: { ...proof.attestation, responseBodyHash: 'ff'.repeat(32) } };
    expect(() => verifySingleAttesterProof(tampered, attester.identity.publicKeyPem)).toThrow(RegistryQuorumError);
  });

  it('assertMinimumTier refuses to accept single-attester when oracle-committee is required', () => {
    const attester = makeOracle('registrar-solo');
    const proof = buildSingleAttesterProof(fetchInput({ oracleId: 'registrar-solo' }), 'registrar-solo', attester.privateKeyPem);
    expect(() => assertMinimumTier(proof, 'oracle-committee')).toThrow(InsufficientProofTierError);
  });

  it('a legacy-unproven credential is never described as anything but unproven', () => {
    const trust = describeTrustLevel({ proofTier: 'legacy-unproven' });
    expect(trust.reducedAssurance).toBe(true);
    expect(trust.label).toMatch(/UNPROVEN/);
  });
});

describe('metadata hash binding (legacy v1 vs proof-bound v2)', () => {
  it('v1 hash matches the original reference-implementation construction', () => {
    const fields = { permitNumber: 'PE-4471', registryUrl: 'https://registry.example.gov', issuedDate: '2020-03-01' };
    const hash = buildMetadataHashV1(fields);
    expect(hash).toHaveLength(32);
  });

  it('v2 document hash changes if the embedded registry proof changes (binding is tamper-evident)', () => {
    const fields = { permitNumber: 'PE-4471', registryUrl: REGISTRY_URL, issuedDate: '2020-03-01' };
    const docA = buildMetadataDocumentV2(fields, { proofTier: 'legacy-unproven' });
    const attester = makeOracle('registrar-solo');
    const proof = buildSingleAttesterProof(fetchInput({ oracleId: 'registrar-solo' }), 'registrar-solo', attester.privateKeyPem);
    const docB = buildMetadataDocumentV2(fields, proof);

    expect(hashMetadataDocument(docA).equals(hashMetadataDocument(docB))).toBe(false);
  });

  it('verifyMetadataHashBinding confirms a document matches its on-chain hash and rejects a substituted document', () => {
    const fields = { permitNumber: 'PE-4471', registryUrl: REGISTRY_URL, issuedDate: '2020-03-01' };
    const doc = buildMetadataDocumentV2(fields, { proofTier: 'legacy-unproven' });
    const onChainHash = hashMetadataDocument(doc);

    expect(verifyMetadataHashBinding(onChainHash, doc)).toBe(true);

    const substituted = buildMetadataDocumentV2({ ...fields, permitNumber: 'PE-9999' }, { proofTier: 'legacy-unproven' });
    expect(verifyMetadataHashBinding(onChainHash, substituted)).toBe(false);
  });
});

describe('end-to-end worked example: issuance and independent re-verification', () => {
  it('issues a credential bound to a 2-of-3 oracle-committee registry proof, then a third party independently re-verifies it later using only the on-chain hash and the published document', () => {
    // --- Setup: three independently-operated oracles, known to verifiers ---
    const oracleGov = makeOracle('gov-registrar');
    const oracleQp = makeOracle('quorumproof-witness');
    const oracleAudit = makeOracle('third-party-auditor');
    const oracleRegistry: OracleIdentity[] = [oracleGov.identity, oracleQp.identity, oracleAudit.identity];

    // --- Step 1: each oracle independently fetches the same registry endpoint ---
    const fetchedAt = new Date().toISOString();
    const attGov = signRegistryFetchAttestation(fetchInput({ oracleId: 'gov-registrar', fetchedAt }), oracleGov.privateKeyPem);
    const attQp = signRegistryFetchAttestation(fetchInput({ oracleId: 'quorumproof-witness', fetchedAt }), oracleQp.privateKeyPem);
    const attAudit = signRegistryFetchAttestation(fetchInput({ oracleId: 'third-party-auditor', fetchedAt }), oracleAudit.privateKeyPem);

    // --- Step 2: form a 2-of-3 quorum ---
    const quorum = formRegistryAttestationQuorum([attGov, attQp, attAudit], oracleRegistry, 2);
    expect(quorum.attestations.length).toBeGreaterThanOrEqual(2);

    // --- Step 3: issuer enforces freshness policy and minimum tier before issuing ---
    const proof = { proofTier: 'oracle-committee' as const, quorum };
    expect(() => checkProofFreshness(proof, { maxAgeSeconds: 300 })).not.toThrow();
    expect(() => assertMinimumTier(proof, 'oracle-committee')).not.toThrow();

    // --- Step 4: build the content-addressed metadata document and publish it ---
    const fields = { permitNumber: 'PE-4471', registryUrl: REGISTRY_URL, issuedDate: '2020-03-01' };
    const document = buildMetadataDocumentV2(fields, proof);
    const store = new RegistryProofStore();
    const contentHash = store.publish(document); // this hex string is what goes into issue_credential's metadata_hash

    // --- Step 5: "on-chain" state now only holds the 32-byte hash ---
    const onChainMetadataHash = Buffer.from(contentHash, 'hex');
    expect(onChainMetadataHash).toHaveLength(32);

    // --- Step 6 (later, independently, by a verifier with no access to issuer infra): ---
    const fetchedDocument = store.fetch(onChainMetadataHash.toString('hex'));
    expect(fetchedDocument).toBeDefined();
    expect(verifyMetadataHashBinding(onChainMetadataHash, fetchedDocument!)).toBe(true);

    const fetchedDoc = fetchedDocument as ReturnType<typeof buildMetadataDocumentV2>;
    expect(() => verifyRegistryProof(fetchedDoc.registryProof, oracleRegistry)).not.toThrow();
    expect(() => checkProofFreshness(fetchedDoc.registryProof, { maxAgeSeconds: 300 })).not.toThrow();
    expect(describeTrustLevel(fetchedDoc.registryProof).reducedAssurance).toBe(false);

    // --- Sanity: if the on-chain hash and the published document don't match (e.g. issuer served the wrong doc), detect it ---
    const wrongDoc = buildMetadataDocumentV2({ ...fields, issuedDate: '1999-01-01' }, proof);
    expect(verifyMetadataHashBinding(onChainMetadataHash, wrongDoc)).toBe(false);
  });
});
