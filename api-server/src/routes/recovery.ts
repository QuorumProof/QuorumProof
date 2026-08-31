import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { getPool } from '../db.js';

const router = Router();

// ---- Postgres-backed store (Issue #1429) ----
// Replaced the in-memory Map/array store with getPool()-backed queries so that
// in-flight recovery sessions survive API server restarts and work correctly
// across multiple server instances.  OTP expiry is enforced via the expires_at
// column; a periodic or on-demand cleanup removes stale rows.

interface RecoveryRequestRow {
  id: string;
  credential_id: string;
  lost_wallet: string;
  new_wallet: string;
  contact_type: 'email' | 'phone';
  contact_value: string;
  status: 'pending_verification' | 'verified' | 'pending_approval' | 'approved' | 'rejected' | 'executed';
  created_at: string;
  verified_at?: string | null;
  resolved_at?: string | null;
  resolved_by?: string | null;
  rejection_reason?: string | null;
  attestors: string[];
}

function generateId(): string {
  return randomBytes(8).toString('hex');
}

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Delete expired OTP rows (best-effort; does not throw on failure). */
async function pruneExpiredOtps(): Promise<void> {
  try {
    await getPool().query('DELETE FROM recovery_otps WHERE expires_at < now()');
  } catch {
    // Non-fatal — the query filter in verify-otp guards correctness.
  }
}

// POST /api/recovery/request
// Body: { credentialId, lostWallet, newWallet, contactType, contactValue }
router.post('/request', async (req: Request, res: Response) => {
  const { credentialId, lostWallet, newWallet, contactType, contactValue } = req.body;

  if (!credentialId || typeof credentialId !== 'string') {
    res.status(400).json({ error: 'credentialId is required' });
    return;
  }
  if (!lostWallet || !/^G[A-Z2-7]{55}$/.test(lostWallet)) {
    res.status(400).json({ error: 'lostWallet must be a valid Stellar address' });
    return;
  }
  if (!newWallet || !/^G[A-Z2-7]{55}$/.test(newWallet)) {
    res.status(400).json({ error: 'newWallet must be a valid Stellar address' });
    return;
  }
  if (lostWallet === newWallet) {
    res.status(400).json({ error: 'newWallet must differ from lostWallet' });
    return;
  }
  if (contactType !== 'email' && contactType !== 'phone') {
    res.status(400).json({ error: 'contactType must be "email" or "phone"' });
    return;
  }
  if (!contactValue || typeof contactValue !== 'string') {
    res.status(400).json({ error: 'contactValue is required' });
    return;
  }

  const id = generateId();
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO recovery_requests
         (id, credential_id, lost_wallet, new_wallet, contact_type, contact_value, status, attestors)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending_verification', '{}')`,
      [id, credentialId, lostWallet, newWallet, contactType, contactValue],
    );

    await pool.query(
      `INSERT INTO recovery_otps (request_id, code, expires_at, attempts)
       VALUES ($1, $2, $3, 0)`,
      [id, otp, expiresAt],
    );
  } catch (err) {
    console.error('[recovery] DB error creating request:', err);
    res.status(500).json({ error: 'Failed to create recovery request' });
    return;
  }

  // Stub: in production, dispatch via SendGrid / Twilio
  if (contactType === 'email') {
    console.log(`[recovery] OTP for request ${id} → email ${contactValue}: ${otp}`);
  } else {
    console.log(`[recovery] OTP for request ${id} → SMS ${contactValue}: ${otp}`);
  }

  res.status(201).json({ requestId: id, message: `Verification code sent to your ${contactType}` });
});

// POST /api/recovery/verify-otp
// Body: { requestId, code }
router.post('/verify-otp', async (req: Request, res: Response) => {
  const { requestId, code } = req.body;

  if (!requestId || typeof requestId !== 'string') {
    res.status(400).json({ error: 'requestId is required' });
    return;
  }
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'code is required' });
    return;
  }

  try {
    const pool = getPool();

    const reqResult = await pool.query<RecoveryRequestRow>(
      'SELECT * FROM recovery_requests WHERE id = $1',
      [requestId],
    );
    if (reqResult.rowCount === 0) {
      res.status(404).json({ error: 'Recovery request not found' });
      return;
    }
    const request = reqResult.rows[0];

    if (request.status !== 'pending_verification') {
      res.status(409).json({ error: 'Request is not awaiting verification' });
      return;
    }

    // Fetch OTP — also filters out expired rows via query
    const otpResult = await pool.query<{ code: string; expires_at: string; attempts: number }>(
      'SELECT code, expires_at, attempts FROM recovery_otps WHERE request_id = $1 AND expires_at > now()',
      [requestId],
    );

    if (otpResult.rowCount === 0) {
      // Either already deleted or expired
      await pool.query('DELETE FROM recovery_otps WHERE request_id = $1', [requestId]);
      res.status(410).json({ error: 'Verification code expired. Please start a new request.' });
      return;
    }

    const otp = otpResult.rows[0];
    const newAttempts = otp.attempts + 1;

    if (newAttempts > 5) {
      await pool.query('DELETE FROM recovery_otps WHERE request_id = $1', [requestId]);
      res.status(429).json({ error: 'Too many attempts. Please start a new request.' });
      return;
    }

    if (otp.code !== code.trim()) {
      await pool.query(
        'UPDATE recovery_otps SET attempts = $1 WHERE request_id = $2',
        [newAttempts, requestId],
      );
      res.status(400).json({ error: `Invalid code. ${5 - newAttempts} attempt(s) remaining.` });
      return;
    }

    // Code is correct — delete OTP and advance status
    await pool.query('DELETE FROM recovery_otps WHERE request_id = $1', [requestId]);
    await pool.query(
      `UPDATE recovery_requests
       SET status = 'pending_approval', verified_at = now()
       WHERE id = $1`,
      [requestId],
    );

    res.json({ success: true, message: 'Identity verified. Your request is now pending attestor approval.' });
  } catch (err) {
    console.error('[recovery] DB error verifying OTP:', err);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// POST /api/recovery/resend-otp
// Body: { requestId }
router.post('/resend-otp', async (req: Request, res: Response) => {
  const { requestId } = req.body;

  if (!requestId || typeof requestId !== 'string') {
    res.status(400).json({ error: 'requestId is required' });
    return;
  }

  try {
    const pool = getPool();

    const reqResult = await pool.query<RecoveryRequestRow>(
      'SELECT * FROM recovery_requests WHERE id = $1',
      [requestId],
    );
    if (reqResult.rowCount === 0) {
      res.status(404).json({ error: 'Recovery request not found' });
      return;
    }
    const request = reqResult.rows[0];

    if (request.status !== 'pending_verification') {
      res.status(409).json({ error: 'Request is not awaiting verification' });
      return;
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Upsert — replace any existing OTP for this request
    await pool.query(
      `INSERT INTO recovery_otps (request_id, code, expires_at, attempts)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (request_id) DO UPDATE
         SET code = EXCLUDED.code,
             expires_at = EXCLUDED.expires_at,
             attempts = 0`,
      [requestId, otp, expiresAt],
    );

    if (request.contact_type === 'email') {
      console.log(`[recovery] Resent OTP for request ${requestId} → email ${request.contact_value}: ${otp}`);
    } else {
      console.log(`[recovery] Resent OTP for request ${requestId} → SMS ${request.contact_value}: ${otp}`);
    }

    res.json({ message: `Verification code resent to your ${request.contact_type}` });
  } catch (err) {
    console.error('[recovery] DB error resending OTP:', err);
    res.status(500).json({ error: 'Failed to resend OTP' });
  }
});

// GET /api/recovery/status/:requestId
router.get('/status/:requestId', async (req: Request, res: Response) => {
  try {
    const result = await getPool().query<RecoveryRequestRow>(
      'SELECT * FROM recovery_requests WHERE id = $1',
      [req.params.requestId],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Recovery request not found' });
      return;
    }

    const { contact_value: _hidden, ...safeRequest } = result.rows[0];
    res.json(safeRequest);
  } catch (err) {
    console.error('[recovery] DB error fetching status:', err);
    res.status(500).json({ error: 'Failed to fetch recovery request' });
  }
});

// GET /api/recovery/pending?attestor=<addr>
// Returns pending_approval requests for attestors to review
router.get('/pending', async (req: Request, res: Response) => {
  const { attestor } = req.query;

  if (!attestor || typeof attestor !== 'string') {
    res.status(400).json({ error: 'attestor query parameter required' });
    return;
  }

  try {
    const result = await getPool().query<RecoveryRequestRow>(
      `SELECT id, credential_id, lost_wallet, new_wallet, contact_type,
              status, created_at, verified_at, resolved_at, resolved_by,
              rejection_reason, attestors
       FROM recovery_requests
       WHERE status = 'pending_approval'
       ORDER BY created_at ASC`,
    );

    const items = result.rows;
    res.json({ attestor, items, total: items.length });
  } catch (err) {
    console.error('[recovery] DB error fetching pending requests:', err);
    res.status(500).json({ error: 'Failed to fetch pending requests' });
  }
});

// POST /api/recovery/approve
// Body: { requestId, attestor }
router.post('/approve', async (req: Request, res: Response) => {
  const { requestId, attestor } = req.body;

  if (!requestId || typeof requestId !== 'string') {
    res.status(400).json({ error: 'requestId is required' });
    return;
  }
  if (!attestor || typeof attestor !== 'string') {
    res.status(400).json({ error: 'attestor is required' });
    return;
  }

  try {
    const pool = getPool();

    const reqResult = await pool.query<RecoveryRequestRow>(
      'SELECT status, attestors FROM recovery_requests WHERE id = $1',
      [requestId],
    );
    if (reqResult.rowCount === 0) {
      res.status(404).json({ error: 'Recovery request not found' });
      return;
    }
    const request = reqResult.rows[0];

    if (request.status !== 'pending_approval') {
      res.status(409).json({ error: `Cannot approve a request with status "${request.status}"` });
      return;
    }

    const updatedAttestors = request.attestors.includes(attestor)
      ? request.attestors
      : [...request.attestors, attestor];

    await pool.query(
      `UPDATE recovery_requests
       SET status = 'approved',
           resolved_at = now(),
           resolved_by = $1,
           attestors = $2
       WHERE id = $3`,
      [attestor, updatedAttestors, requestId],
    );

    console.log(`[recovery] Request ${requestId} approved by attestor ${attestor}`);
    res.json({ success: true, message: 'Recovery request approved. Credential re-issuance has been initiated.' });
  } catch (err) {
    console.error('[recovery] DB error approving request:', err);
    res.status(500).json({ error: 'Failed to approve recovery request' });
  }
});

// POST /api/recovery/reject
// Body: { requestId, attestor, reason }
router.post('/reject', async (req: Request, res: Response) => {
  const { requestId, attestor, reason } = req.body;

  if (!requestId || typeof requestId !== 'string') {
    res.status(400).json({ error: 'requestId is required' });
    return;
  }
  if (!attestor || typeof attestor !== 'string') {
    res.status(400).json({ error: 'attestor is required' });
    return;
  }

  try {
    const pool = getPool();

    const reqResult = await pool.query<RecoveryRequestRow>(
      'SELECT status FROM recovery_requests WHERE id = $1',
      [requestId],
    );
    if (reqResult.rowCount === 0) {
      res.status(404).json({ error: 'Recovery request not found' });
      return;
    }
    const request = reqResult.rows[0];

    if (request.status !== 'pending_approval') {
      res.status(409).json({ error: `Cannot reject a request with status "${request.status}"` });
      return;
    }

    await pool.query(
      `UPDATE recovery_requests
       SET status = 'rejected',
           resolved_at = now(),
           resolved_by = $1,
           rejection_reason = $2
       WHERE id = $3`,
      [attestor, reason ?? 'No reason provided', requestId],
    );

    console.log(`[recovery] Request ${requestId} rejected by attestor ${attestor}`);
    res.json({ success: true, message: 'Recovery request rejected.' });
  } catch (err) {
    console.error('[recovery] DB error rejecting request:', err);
    res.status(500).json({ error: 'Failed to reject recovery request' });
  }
});

// Expose pruneExpiredOtps for the startup scheduler / test helpers.
export { pruneExpiredOtps };
export default router;
