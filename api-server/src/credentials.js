/**
 * credentials.js — API routes for credential issuance and verification
 * Issue #470: POST /api/credentials/:id/verify
 * Issue #471: POST /api/credentials/issue
 */
import { Router } from 'express';

const router = Router();

// In-memory store (replace with on-chain calls in production)
let nextId = 1n;
const credentials = new Map(); // id -> credential object

/**
 * POST /api/credentials/issue
 * Body: { subject, credential_type, metadata_hash, issuer }
 * Returns: { credential_id }
 */
router.post('/issue', (req, res) => {
  const { subject, credential_type, metadata_hash, issuer } = req.body ?? {};

  if (!subject || typeof subject !== 'string') {
    return res.status(400).json({ error: 'subject is required' });
  }
  if (!credential_type || typeof credential_type !== 'number') {
    return res.status(400).json({ error: 'credential_type must be a number' });
  }
  if (!metadata_hash || typeof metadata_hash !== 'string') {
    return res.status(400).json({ error: 'metadata_hash is required' });
  }
  if (!issuer || typeof issuer !== 'string') {
    return res.status(400).json({ error: 'issuer is required' });
  }

  const id = String(nextId++);
  credentials.set(id, {
    id,
    subject,
    issuer,
    credential_type,
    metadata_hash,
    revoked: false,
    attestors: [],
    issued_at: new Date().toISOString(),
  });

  return res.status(201).json({ credential_id: id });
});

/**
 * POST /api/credentials/:id/verify
 * Body: { verifier_address, delegation_proof? }
 * Returns: { verified, credential_id, attestors, attested }
 */
router.post('/:id/verify', (req, res) => {
  const { id } = req.params;
  const { verifier_address, delegation_proof } = req.body ?? {};

  if (!verifier_address || typeof verifier_address !== 'string') {
    return res.status(400).json({ error: 'verifier_address is required' });
  }

  const credential = credentials.get(id);
  if (!credential) {
    return res.status(404).json({ error: `Credential ${id} not found` });
  }

  if (credential.revoked) {
    return res.status(200).json({
      verified: false,
      credential_id: id,
      reason: 'revoked',
      attestors: credential.attestors,
      attested: false,
    });
  }

  const attested = credential.attestors.length > 0;

  return res.status(200).json({
    verified: true,
    credential_id: id,
    subject: credential.subject,
    issuer: credential.issuer,
    credential_type: credential.credential_type,
    attestors: credential.attestors,
    attested,
    delegation_proof_provided: !!delegation_proof,
  });
});

// Expose store for testing
export { credentials, router };
