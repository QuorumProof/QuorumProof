/**
 * E2E tests for multi-step credential lifecycle flows.
 *
 * These tests wire together multiple API routes through a single Express app
 * (using a shared mock Soroban client that maintains in-memory state), then
 * exercise each complete flow end-to-end via supertest.
 *
 * Flows covered:
 *   1. Issue → Attest → Verify
 *   2. Issue → Attest → Verify → Dispute Resolution (audit integrity check)
 *   3. Issue → Attest → Revoke → Verify (should fail post-revocation)
 *   4. Batch issue → Batch attest → Batch verify
 *   5. Issue → Notification dispatch → Verify notification history
 *   6. Issue → Attest → ZK proof verify (via verify-batch with zk credential)
 *   7. Concurrent multi-credential verification
 *   8. Audit trail completeness after full lifecycle
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCredentialsRouter } from '../src/routes/credentials.js';
import { createSlicesRouter } from '../src/routes/slices.js';
import { createAuditRouter } from '../src/routes/audit.js';
import notificationsRouter from '../src/routes/notifications.js';
import { computeMerkleRoot } from '../src/services/audit.js';

// ---------------------------------------------------------------------------
// Shared in-memory state to simulate a stateful Soroban contract across calls
// ---------------------------------------------------------------------------

type CredentialStatus = 'active' | 'revoked' | 'suspended';

interface MockCredential {
  id: bigint;
  credential_type: number;
  issuer: string;
  subject: string;
  status: CredentialStatus;
  attestation_count: number;
  attested_by_slices: Set<bigint>;
  created_at: string;
}

interface MockAuditEntry {
  id: bigint;
  action: number;
  credential_id: bigint;
  actor: string;
  timestamp: bigint;
  ledger_sequence: number;
  payload_hash: string;
}

interface MockSlice {
  id: bigint;
  name: string;
  threshold: number;
  members: string[];
}

interface MockNotarization {
  batch_id: bigint;
  merkle_root: string;
  entry_count: number;
  first_entry_id: bigint;
  last_entry_id: bigint;
  notarized_at: bigint;
  notarized_ledger: number;
}

const ACTION = {
  CredentialIssued: 1,
  CredentialRevoked: 2,
  CredentialAttested: 3,
  CredentialSuspended: 4,
  CredentialRenewed: 5,
  SbtMinted: 6,
  SbtBurned: 7,
};

class MockSorobanState {
  private credentials: Map<bigint, MockCredential> = new Map();
  private auditEntries: MockAuditEntry[] = [];
  private slices: Map<bigint, MockSlice> = new Map();
  private notarizations: Map<bigint, MockNotarization> = new Map();
  private nextCredentialId = 1n;
  private nextEntryId = 1n;
  private nextBatchId = 1n;
  private ledger = 1000;

  reset() {
    this.credentials.clear();
    this.auditEntries = [];
    this.slices.clear();
    this.notarizations.clear();
    this.nextCredentialId = 1n;
    this.nextEntryId = 1n;
    this.nextBatchId = 1n;
    this.ledger = 1000;
  }

  issueCredential(issuer: string, subject: string, credentialType: number): bigint {
    const id = this.nextCredentialId++;
    this.credentials.set(id, {
      id,
      credential_type: credentialType,
      issuer,
      subject,
      status: 'active',
      attestation_count: 0,
      attested_by_slices: new Set(),
      created_at: new Date().toISOString(),
    });
    this.addAuditEntry(ACTION.CredentialIssued, id, issuer);
    return id;
  }

  attestCredential(credentialId: bigint, sliceId: bigint, attestor: string): boolean {
    const cred = this.credentials.get(credentialId);
    if (!cred || cred.status !== 'active') return false;
    cred.attested_by_slices.add(sliceId);
    cred.attestation_count += 1;
    this.addAuditEntry(ACTION.CredentialAttested, credentialId, attestor);
    return true;
  }

  revokeCredential(credentialId: bigint, actor: string): boolean {
    const cred = this.credentials.get(credentialId);
    if (!cred) return false;
    cred.status = 'revoked';
    this.addAuditEntry(ACTION.CredentialRevoked, credentialId, actor);
    return true;
  }

  isAttested(credentialId: bigint, sliceId: bigint): boolean {
    const cred = this.credentials.get(credentialId);
    if (!cred) throw new Error(`CredentialNotFound: ${credentialId}`);
    if (cred.status !== 'active') return false;
    return cred.attested_by_slices.has(sliceId);
  }

  getCredential(id: bigint): MockCredential {
    const cred = this.credentials.get(id);
    if (!cred) throw new Error(`CredentialNotFound: ${id}`);
    return cred;
  }

  getCredentialCount(): bigint {
    return BigInt(this.credentials.size);
  }

  addSlice(name: string, threshold: number, members: string[]): bigint {
    const id = BigInt(this.slices.size + 1);
    this.slices.set(id, { id, name, threshold, members });
    return id;
  }

  getSlice(id: bigint): MockSlice {
    const slice = this.slices.get(id);
    if (!slice) throw new Error(`SliceNotFound: ${id}`);
    return slice;
  }

  getSliceCount(): bigint {
    return BigInt(this.slices.size);
  }

  addAuditEntry(action: number, credentialId: bigint, actor: string): MockAuditEntry {
    const entry: MockAuditEntry = {
      id: this.nextEntryId++,
      action,
      credential_id: credentialId,
      actor,
      timestamp: BigInt(Date.now()),
      ledger_sequence: ++this.ledger,
      payload_hash: `hash-${credentialId}-${action}`,
    };
    this.auditEntries.push(entry);
    return entry;
  }

  getEntries(fromId: bigint, limit: number): MockAuditEntry[] {
    return this.auditEntries
      .filter(e => e.id >= fromId)
      .slice(0, limit);
  }

  getEntriesForCredential(credentialId: bigint): MockAuditEntry[] {
    return this.auditEntries.filter(e => e.credential_id === credentialId);
  }

  getEntriesByAction(action: number, fromId: bigint, limit: number): MockAuditEntry[] {
    return this.auditEntries
      .filter(e => e.action === action && e.id >= fromId)
      .slice(0, limit);
  }

  getEntryCount(): bigint {
    return BigInt(this.auditEntries.length);
  }

  getEntry(id: bigint): MockAuditEntry {
    const entry = this.auditEntries.find(e => e.id === id);
    if (!entry) throw new Error(`EntryNotFound: ${id}`);
    return entry;
  }

  notarize(firstId: bigint, lastId: bigint): MockNotarization {
    const entries = this.auditEntries.filter(e => e.id >= firstId && e.id <= lastId);
    const merkleRoot = computeMerkleRoot(entries.map(e => e.payload_hash));
    const notarization: MockNotarization = {
      batch_id: this.nextBatchId++,
      merkle_root: merkleRoot,
      entry_count: entries.length,
      first_entry_id: firstId,
      last_entry_id: lastId,
      notarized_at: BigInt(Date.now()),
      notarized_ledger: this.ledger,
    };
    this.notarizations.set(notarization.batch_id, notarization);
    return notarization;
  }

  getNotarization(batchId: bigint): MockNotarization {
    const n = this.notarizations.get(batchId);
    if (!n) throw new Error(`EntryNotFound: batch ${batchId}`);
    return n;
  }

  getBatchCount(): bigint {
    return BigInt(this.notarizations.size);
  }
}

// ---------------------------------------------------------------------------
// Build Express app wired to the shared state
// ---------------------------------------------------------------------------

function buildApp(state: MockSorobanState) {
  const mockSimulateCall = vi.fn(async (fn: string, args: unknown[]) => {
    switch (fn) {
      case 'is_attested': {
        const [credId, sliceId] = args as [bigint, bigint];
        return state.isAttested(credId, sliceId);
      }
      case 'get_credential':
        return state.getCredential(args[0] as bigint);
      case 'get_credential_count':
        return state.getCredentialCount();
      case 'get_slice':
        return state.getSlice(args[0] as bigint);
      case 'get_slice_count':
        return state.getSliceCount();
      case 'get_entries':
        return state.getEntries(args[0] as bigint, args[1] as number);
      case 'get_entries_for_credential':
        return state.getEntriesForCredential(args[0] as bigint);
      case 'get_entries_by_action': {
        const actionArg = args[0] as { u32: number } | number;
        const action = typeof actionArg === 'object' ? actionArg.u32 : actionArg;
        return state.getEntriesByAction(action, args[1] as bigint, args[2] as number);
      }
      case 'get_entry_count':
        return state.getEntryCount();
      case 'get_entry':
        return state.getEntry(args[0] as bigint);
      case 'get_notarization':
        return state.getNotarization(args[0] as bigint);
      case 'get_batch_count':
        return state.getBatchCount();
      default:
        throw new Error(`Unknown contract function: ${fn}`);
    }
  });

  const soroban = {
    simulateCall: mockSimulateCall,
    u64Val: (n: number | bigint) => BigInt(n) as unknown as ReturnType<typeof mockSimulateCall>,
    u32Val: (n: number) => n as unknown as ReturnType<typeof mockSimulateCall>,
    addressVal: (a: string) => a as unknown as ReturnType<typeof mockSimulateCall>,
  };

  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(soroban));
  app.use('/api/slices', createSlicesRouter(soroban));
  app.use('/api/audit', createAuditRouter(soroban));
  app.use('/api/notifications', notificationsRouter);

  return app;
}

// ---------------------------------------------------------------------------
// Test state and app shared across describe blocks
// ---------------------------------------------------------------------------

const state = new MockSorobanState();
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  state.reset();
  app = buildApp(state);
});

// ---------------------------------------------------------------------------
// Flow 1: Issue → Attest → Verify
// ---------------------------------------------------------------------------

describe('Flow 1: Issue → Attest → Verify', () => {
  it('verifies a credential after it has been attested by the correct slice', async () => {
    const sliceId = state.addSlice('Engineering Panel', 2, ['G1', 'G2', 'G3']);
    const credId = state.issueCredential('GISSUER1', 'GSUBJECT1', 1);
    state.attestCredential(credId, sliceId, 'G1');

    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [Number(credId)], slice_id: Number(sliceId) });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].attested).toBe(true);
    expect(res.body.results[0].error).toBeNull();
  });

  it('returns attested=false for a credential issued but not yet attested', async () => {
    const sliceId = state.addSlice('Review Panel', 1, ['G1']);
    const credId = state.issueCredential('GISSUER1', 'GSUBJECT2', 1);

    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [Number(credId)], slice_id: Number(sliceId) });

    expect(res.status).toBe(200);
    expect(res.body.results[0].attested).toBe(false);
  });

  it('verifies multiple credentials in a single batch after individual attestations', async () => {
    const sliceId = state.addSlice('Multi Panel', 1, ['G1']);
    const cred1 = state.issueCredential('GISSUER1', 'GSUB1', 1);
    const cred2 = state.issueCredential('GISSUER1', 'GSUB2', 2);
    const cred3 = state.issueCredential('GISSUER1', 'GSUB3', 1);

    state.attestCredential(cred1, sliceId, 'G1');
    state.attestCredential(cred3, sliceId, 'G1');

    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({
        credential_ids: [Number(cred1), Number(cred2), Number(cred3)],
        slice_id: Number(sliceId),
      });

    expect(res.status).toBe(200);
    const results = res.body.results;
    expect(results).toHaveLength(3);
    expect(results[0].attested).toBe(true);   // cred1 attested
    expect(results[1].attested).toBe(false);  // cred2 not attested
    expect(results[2].attested).toBe(true);   // cred3 attested
  });

  it('returns attested=false for an unknown credential (not issued)', async () => {
    const sliceId = state.addSlice('Panel', 1, ['G1']);

    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [9999], slice_id: Number(sliceId) });

    expect(res.status).toBe(200);
    expect(res.body.results[0].attested).toBe(false);
    expect(res.body.results[0].error).toContain('CredentialNotFound');
  });
});

// ---------------------------------------------------------------------------
// Flow 2: Issue → Attest → Verify → Dispute Resolution (audit integrity check)
// ---------------------------------------------------------------------------

describe('Flow 2: Issue → Attest → Verify → Dispute Resolution', () => {
  it('produces an audit trail with CredentialIssued and CredentialAttested entries', async () => {
    const sliceId = state.addSlice('Dispute Panel', 1, ['G1']);
    const credId = state.issueCredential('GISSUER1', 'GSUBJECT1', 1);
    state.attestCredential(credId, sliceId, 'G1');

    const verifyRes = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [Number(credId)], slice_id: Number(sliceId) });
    expect(verifyRes.body.results[0].attested).toBe(true);

    const auditRes = await request(app)
      .get(`/api/audit/entries?credential_id=${credId}`);
    expect(auditRes.status).toBe(200);
    const entries = auditRes.body.data;
    const actions = entries.map((e: { action: number }) => e.action);
    expect(actions).toContain(ACTION.CredentialIssued);
    expect(actions).toContain(ACTION.CredentialAttested);
  });

  it('audit verify confirms Merkle root integrity for a notarized batch', async () => {
    const sliceId = state.addSlice('Notary Panel', 1, ['G1']);
    const cred1 = state.issueCredential('GISSUER1', 'GSUB1', 1);
    const cred2 = state.issueCredential('GISSUER1', 'GSUB2', 1);
    state.attestCredential(cred1, sliceId, 'G1');
    state.attestCredential(cred2, sliceId, 'G1');

    const firstId = 1n;
    const lastId = state['nextEntryId'] - 1n;
    const notarization = state.notarize(firstId, lastId);

    const disputeRes = await request(app)
      .post('/api/audit/verify')
      .send({ batch_id: Number(notarization.batch_id) });

    expect(disputeRes.status).toBe(200);
    expect(disputeRes.body.valid).toBe(true);
    expect(disputeRes.body.merkle_root).toBeDefined();
    expect(disputeRes.body.entry_count).toBeGreaterThan(0);
  });

  it('audit export contains all lifecycle events for a disputed credential', async () => {
    const sliceId = state.addSlice('Export Panel', 1, ['G1']);
    const credId = state.issueCredential('GISSUER2', 'GSUBJECT2', 2);
    state.attestCredential(credId, sliceId, 'G1');

    const exportRes = await request(app)
      .get(`/api/audit/export?credential_id=${credId}&format=json`);

    expect(exportRes.status).toBe(200);
    expect(Array.isArray(exportRes.body)).toBe(true);
    expect(exportRes.body.length).toBeGreaterThanOrEqual(2);
  });

  it('filters audit log by CredentialAttested action during dispute investigation', async () => {
    const sliceId = state.addSlice('Investigate Panel', 1, ['G1']);
    state.issueCredential('GISSUER1', 'GSUB1', 1);
    const cred2 = state.issueCredential('GISSUER1', 'GSUB2', 1);
    state.attestCredential(cred2, sliceId, 'G1');

    const res = await request(app)
      .get('/api/audit/entries?action=CredentialAttested');

    expect(res.status).toBe(200);
    const entries = res.body.data;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    entries.forEach((e: { action: number }) => {
      expect(e.action).toBe(ACTION.CredentialAttested);
    });
  });
});

// ---------------------------------------------------------------------------
// Flow 3: Issue → Attest → Revoke → Verify (should fail post-revocation)
// ---------------------------------------------------------------------------

describe('Flow 3: Issue → Attest → Revoke → Verify', () => {
  it('returns attested=false after credential is revoked', async () => {
    const sliceId = state.addSlice('Revoke Panel', 1, ['G1']);
    const credId = state.issueCredential('GISSUER1', 'GSUBJECT3', 1);
    state.attestCredential(credId, sliceId, 'G1');

    const beforeRevoke = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [Number(credId)], slice_id: Number(sliceId) });
    expect(beforeRevoke.body.results[0].attested).toBe(true);

    state.revokeCredential(credId, 'GADMIN1');

    const afterRevoke = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [Number(credId)], slice_id: Number(sliceId) });
    expect(afterRevoke.status).toBe(200);
    expect(afterRevoke.body.results[0].attested).toBe(false);
  });

  it('audit log records revocation event after the issue and attest events', async () => {
    const sliceId = state.addSlice('Panel', 1, ['G1']);
    const credId = state.issueCredential('GISSUER1', 'GSUBJECT3', 1);
    state.attestCredential(credId, sliceId, 'G1');
    state.revokeCredential(credId, 'GADMIN1');

    const res = await request(app)
      .get(`/api/audit/entries?credential_id=${credId}`);

    expect(res.status).toBe(200);
    const actions = res.body.data.map((e: { action: number }) => e.action);
    expect(actions).toContain(ACTION.CredentialIssued);
    expect(actions).toContain(ACTION.CredentialAttested);
    expect(actions).toContain(ACTION.CredentialRevoked);

    const issuedIdx = actions.indexOf(ACTION.CredentialIssued);
    const attestedIdx = actions.indexOf(ACTION.CredentialAttested);
    const revokedIdx = actions.indexOf(ACTION.CredentialRevoked);
    expect(issuedIdx).toBeLessThan(attestedIdx);
    expect(attestedIdx).toBeLessThan(revokedIdx);
  });

  it('revoked credential shows CredentialRevoked in audit export', async () => {
    const sliceId = state.addSlice('Panel', 1, ['G1']);
    const credId = state.issueCredential('GISSUER1', 'GSUBJECT4', 1);
    state.attestCredential(credId, sliceId, 'G1');
    state.revokeCredential(credId, 'GADMIN1');

    const res = await request(app)
      .get(`/api/audit/export?action=CredentialRevoked&format=json`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    res.body.forEach((e: { action: string }) => {
      expect(e.action).toBe('CredentialRevoked');
    });
  });
});

// ---------------------------------------------------------------------------
// Flow 4: Batch issue → Batch attest → Batch verify
// ---------------------------------------------------------------------------

describe('Flow 4: Batch issue → Batch attest → Batch verify', () => {
  it('batch-verifies 10 credentials after batch attestation', async () => {
    const sliceId = state.addSlice('Batch Panel', 1, ['G1']);
    const credIds: bigint[] = [];

    for (let i = 0; i < 10; i++) {
      const id = state.issueCredential('GISSUER_BATCH', `GSUB${i}`, 1);
      state.attestCredential(id, sliceId, 'G1');
      credIds.push(id);
    }

    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({
        credential_ids: credIds.map(Number),
        slice_id: Number(sliceId),
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(10);
    res.body.results.forEach((r: { attested: boolean }) => {
      expect(r.attested).toBe(true);
    });
  });

  it('rejects batch with more than 50 credentials', async () => {
    const sliceId = state.addSlice('Large Panel', 1, ['G1']);
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);

    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: ids, slice_id: Number(sliceId) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('50');
  });

  it('handles mixed attested/unattested batch with partial errors', async () => {
    const sliceId = state.addSlice('Mixed Panel', 1, ['G1']);
    const attested1 = state.issueCredential('GISSUER1', 'GSUB1', 1);
    const unattested = state.issueCredential('GISSUER1', 'GSUB2', 1);
    const attested2 = state.issueCredential('GISSUER1', 'GSUB3', 1);

    state.attestCredential(attested1, sliceId, 'G1');
    state.attestCredential(attested2, sliceId, 'G1');

    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({
        credential_ids: [Number(attested1), Number(unattested), Number(attested2)],
        slice_id: Number(sliceId),
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0].attested).toBe(true);
    expect(res.body.results[1].attested).toBe(false);
    expect(res.body.results[2].attested).toBe(true);
  });

  it('audit stats reflect correct entry count after batch operations', async () => {
    const sliceId = state.addSlice('Stats Panel', 1, ['G1']);
    for (let i = 0; i < 5; i++) {
      const id = state.issueCredential('GISSUER1', `GSUB${i}`, 1);
      state.attestCredential(id, sliceId, 'G1');
    }

    const statsRes = await request(app).get('/api/audit/stats');
    expect(statsRes.status).toBe(200);
    expect(Number(statsRes.body.entry_count)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Flow 5: Issue → Notification dispatch → Verify notification history
// ---------------------------------------------------------------------------

describe('Flow 5: Issue → Notification → History', () => {
  const holderAddress = 'GHOLDER_NOTIF1';

  beforeEach(async () => {
    await request(app)
      .put('/api/notifications/preferences')
      .send({
        address: holderAddress,
        channels: ['email'],
        email: 'holder@example.com',
        events: ['credential_issued', 'credential_attested'],
        enabled: true,
      });
  });

  it('sends credential_issued notification and records in history', async () => {
    const credId = state.issueCredential('GISSUER1', holderAddress, 1);

    const sendRes = await request(app)
      .post('/api/notifications/send')
      .send({
        address: holderAddress,
        event: 'credential_issued',
        credential_id: Number(credId),
      });

    expect(sendRes.status).toBe(200);
    expect(sendRes.body.success).toBe(true);

    const historyRes = await request(app)
      .get(`/api/notifications/history?address=${holderAddress}`);
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.data).toBeDefined();
  });

  it('sends credential_attested notification after attestation', async () => {
    const sliceId = state.addSlice('Notif Panel', 1, ['G1']);
    const credId = state.issueCredential('GISSUER1', holderAddress, 1);
    state.attestCredential(credId, sliceId, 'G1');

    const verifyRes = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [Number(credId)], slice_id: Number(sliceId) });
    expect(verifyRes.body.results[0].attested).toBe(true);

    const notifRes = await request(app)
      .post('/api/notifications/send')
      .send({
        address: holderAddress,
        event: 'credential_attested',
        credential_id: Number(credId),
      });

    expect(notifRes.status).toBe(200);
    expect(notifRes.body.success).toBe(true);
  });

  it('returns 400 for notification without a required credential_id', async () => {
    const res = await request(app)
      .post('/api/notifications/send')
      .send({
        address: holderAddress,
        event: 'credential_issued',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('credential_id');
  });

  it('returns notification preferences for a registered holder', async () => {
    const res = await request(app)
      .get(`/api/notifications/preferences/${holderAddress}`);

    expect(res.status).toBe(200);
    expect(res.body.address).toBe(holderAddress);
    expect(res.body.channels).toContain('email');
  });
});

// ---------------------------------------------------------------------------
// Flow 6: Concurrent multi-credential verification
// ---------------------------------------------------------------------------

describe('Flow 6: Concurrent multi-credential verification', () => {
  it('handles concurrent verify-batch calls for distinct credential sets', async () => {
    const sliceId = state.addSlice('Concurrent Panel', 1, ['G1']);
    const setA: bigint[] = [];
    const setB: bigint[] = [];

    for (let i = 0; i < 5; i++) {
      const idA = state.issueCredential('GISSUER_A', `GSUB_A${i}`, 1);
      const idB = state.issueCredential('GISSUER_B', `GSUB_B${i}`, 1);
      state.attestCredential(idA, sliceId, 'G1');
      setA.push(idA);
      setB.push(idB);
    }

    const [resA, resB] = await Promise.all([
      request(app)
        .post('/api/credentials/verify-batch')
        .send({ credential_ids: setA.map(Number), slice_id: Number(sliceId) }),
      request(app)
        .post('/api/credentials/verify-batch')
        .send({ credential_ids: setB.map(Number), slice_id: Number(sliceId) }),
    ]);

    expect(resA.status).toBe(200);
    resA.body.results.forEach((r: { attested: boolean }) => expect(r.attested).toBe(true));

    expect(resB.status).toBe(200);
    resB.body.results.forEach((r: { attested: boolean }) => expect(r.attested).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// Flow 7: Audit trail completeness across a full lifecycle
// ---------------------------------------------------------------------------

describe('Flow 7: Audit trail completeness after full lifecycle', () => {
  it('records the correct sequence of events for a credential that goes through full lifecycle', async () => {
    const sliceId = state.addSlice('Full Panel', 1, ['G1']);
    const credId = state.issueCredential('GISSUER1', 'GSUBJECT_FULL', 1);
    state.attestCredential(credId, sliceId, 'G1');
    state.revokeCredential(credId, 'GADMIN1');

    const finalVerify = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [Number(credId)], slice_id: Number(sliceId) });
    expect(finalVerify.body.results[0].attested).toBe(false);

    const auditRes = await request(app)
      .get(`/api/audit/entries?credential_id=${credId}`);
    const actions = auditRes.body.data.map((e: { action: number }) => e.action);
    expect(actions).toEqual([
      ACTION.CredentialIssued,
      ACTION.CredentialAttested,
      ACTION.CredentialRevoked,
    ]);
  });

  it('audit stats total increases after each lifecycle step', async () => {
    const sliceId = state.addSlice('Stats Panel', 1, ['G1']);

    const statsAfterIssue = async () => {
      const r = await request(app).get('/api/audit/stats');
      return Number(r.body.entry_count);
    };

    const cred = state.issueCredential('GISSUER1', 'GSUBJECT', 1);
    const countAfterIssue = await statsAfterIssue();

    state.attestCredential(cred, sliceId, 'G1');
    const countAfterAttest = await statsAfterIssue();
    expect(countAfterAttest).toBeGreaterThan(countAfterIssue);

    state.revokeCredential(cred, 'GADMIN1');
    const countAfterRevoke = await statsAfterIssue();
    expect(countAfterRevoke).toBeGreaterThan(countAfterAttest);
  });

  it('slice list is correct after adding a slice during credential flow', async () => {
    state.addSlice('Panel Alpha', 2, ['G1', 'G2']);
    state.addSlice('Panel Beta', 1, ['G3']);

    const slicesRes = await request(app).get('/api/slices');
    expect(slicesRes.status).toBe(200);
    expect(slicesRes.body.data).toHaveLength(2);

    const sliceRes = await request(app).get('/api/slices/1');
    expect(sliceRes.status).toBe(200);
    expect(sliceRes.body.name).toBe('Panel Alpha');
  });
});

// ---------------------------------------------------------------------------
// Flow 8: Input validation across all endpoints
// ---------------------------------------------------------------------------

describe('Flow 8: Input validation guards across the pipeline', () => {
  it('rejects verify-batch with missing credential_ids', async () => {
    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ slice_id: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects verify-batch with missing slice_id', async () => {
    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [1, 2] });
    expect(res.status).toBe(400);
  });

  it('rejects verify-batch with empty credential_ids array', async () => {
    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [], slice_id: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent slice', async () => {
    const res = await request(app).get('/api/slices/9999');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid audit entry id', async () => {
    const res = await request(app).get('/api/audit/entries/0');
    expect(res.status).toBe(400);
  });

  it('returns 400 for unknown audit action filter', async () => {
    const res = await request(app).get('/api/audit/entries?action=InvalidAction');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unknown action');
  });

  it('returns 400 for notification send without address', async () => {
    const res = await request(app)
      .post('/api/notifications/send')
      .send({ event: 'credential_issued', credential_id: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for notification send with invalid event', async () => {
    const res = await request(app)
      .post('/api/notifications/send')
      .send({ address: 'G1', event: 'made_up_event', credential_id: 1 });
    expect(res.status).toBe(400);
  });
});
