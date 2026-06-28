import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';

const router = Router();

// ---- In-memory store (mirrors the notifications.ts pattern) ----

interface RecoveryRequest {
  id: string;
  credentialId: string;
  lostWallet: string;
  newWallet: string;
  contactType: 'email' | 'phone';
  contactValue: string;
  status: 'pending_verification' | 'verified' | 'pending_approval' | 'approved' | 'rejected' | 'executed';
  createdAt: string;
  verifiedAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  rejectionReason?: string;
  attestors: string[];
}

interface PendingOtp {
  requestId: string;
  code: string;
  expiresAt: number;
  attempts: number;
}

const recoveryRequests = new Map<string, RecoveryRequest>();
const pendingOtps = new Map<string, PendingOtp>();

function generateId(): string {
  return randomBytes(8).toString('hex');
}

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// POST /api/recovery/request
// Body: { credentialId, lostWallet, newWallet, contactType, contactValue }
router.post('/request', (req: Request, res: Response) => {
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

  recoveryRequests.set(id, {
    id,
    credentialId,
    lostWallet,
    newWallet,
    contactType,
    contactValue,
    status: 'pending_verification',
    createdAt: new Date().toISOString(),
    attestors: [],
  });

  pendingOtps.set(id, {
    requestId: id,
    code: otp,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    attempts: 0,
  });

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
router.post('/verify-otp', (req: Request, res: Response) => {
  const { requestId, code } = req.body;

  if (!requestId || typeof requestId !== 'string') {
    res.status(400).json({ error: 'requestId is required' });
    return;
  }
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'code is required' });
    return;
  }

  const request = recoveryRequests.get(requestId);
  if (!request) {
    res.status(404).json({ error: 'Recovery request not found' });
    return;
  }
  if (request.status !== 'pending_verification') {
    res.status(409).json({ error: 'Request is not awaiting verification' });
    return;
  }

  const otpRecord = pendingOtps.get(requestId);
  if (!otpRecord) {
    res.status(410).json({ error: 'Verification code expired. Please start a new request.' });
    return;
  }
  if (Date.now() > otpRecord.expiresAt) {
    pendingOtps.delete(requestId);
    res.status(410).json({ error: 'Verification code expired. Please start a new request.' });
    return;
  }

  otpRecord.attempts += 1;
  if (otpRecord.attempts > 5) {
    pendingOtps.delete(requestId);
    res.status(429).json({ error: 'Too many attempts. Please start a new request.' });
    return;
  }

  if (otpRecord.code !== code.trim()) {
    res.status(400).json({ error: `Invalid code. ${5 - otpRecord.attempts} attempt(s) remaining.` });
    return;
  }

  pendingOtps.delete(requestId);
  request.status = 'pending_approval';
  request.verifiedAt = new Date().toISOString();

  res.json({ success: true, message: 'Identity verified. Your request is now pending attestor approval.' });
});

// POST /api/recovery/resend-otp
// Body: { requestId }
router.post('/resend-otp', (req: Request, res: Response) => {
  const { requestId } = req.body;

  if (!requestId || typeof requestId !== 'string') {
    res.status(400).json({ error: 'requestId is required' });
    return;
  }

  const request = recoveryRequests.get(requestId);
  if (!request) {
    res.status(404).json({ error: 'Recovery request not found' });
    return;
  }
  if (request.status !== 'pending_verification') {
    res.status(409).json({ error: 'Request is not awaiting verification' });
    return;
  }

  const otp = generateOtp();
  pendingOtps.set(requestId, {
    requestId,
    code: otp,
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0,
  });

  if (request.contactType === 'email') {
    console.log(`[recovery] Resent OTP for request ${requestId} → email ${request.contactValue}: ${otp}`);
  } else {
    console.log(`[recovery] Resent OTP for request ${requestId} → SMS ${request.contactValue}: ${otp}`);
  }

  res.json({ message: `Verification code resent to your ${request.contactType}` });
});

// GET /api/recovery/status/:requestId
router.get('/status/:requestId', (req: Request, res: Response) => {
  const request = recoveryRequests.get(req.params.requestId);
  if (!request) {
    res.status(404).json({ error: 'Recovery request not found' });
    return;
  }

  const { contactValue: _hidden, ...safeRequest } = request;
  res.json(safeRequest);
});

// GET /api/recovery/pending?attestor=<addr>
// Returns pending_approval requests for attestors to review
router.get('/pending', (req: Request, res: Response) => {
  const { attestor } = req.query;

  if (!attestor || typeof attestor !== 'string') {
    res.status(400).json({ error: 'attestor query parameter required' });
    return;
  }

  const pending = Array.from(recoveryRequests.values())
    .filter((r) => r.status === 'pending_approval')
    .map(({ contactValue: _hidden, ...r }) => r);

  res.json({ attestor, items: pending, total: pending.length });
});

// POST /api/recovery/approve
// Body: { requestId, attestor }
router.post('/approve', (req: Request, res: Response) => {
  const { requestId, attestor } = req.body;

  if (!requestId || typeof requestId !== 'string') {
    res.status(400).json({ error: 'requestId is required' });
    return;
  }
  if (!attestor || typeof attestor !== 'string') {
    res.status(400).json({ error: 'attestor is required' });
    return;
  }

  const request = recoveryRequests.get(requestId);
  if (!request) {
    res.status(404).json({ error: 'Recovery request not found' });
    return;
  }
  if (request.status !== 'pending_approval') {
    res.status(409).json({ error: `Cannot approve a request with status "${request.status}"` });
    return;
  }

  if (!request.attestors.includes(attestor)) {
    request.attestors.push(attestor);
  }

  request.status = 'approved';
  request.resolvedAt = new Date().toISOString();
  request.resolvedBy = attestor;

  console.log(`[recovery] Request ${requestId} approved by attestor ${attestor}`);

  res.json({ success: true, message: 'Recovery request approved. Credential re-issuance has been initiated.' });
});

// POST /api/recovery/reject
// Body: { requestId, attestor, reason }
router.post('/reject', (req: Request, res: Response) => {
  const { requestId, attestor, reason } = req.body;

  if (!requestId || typeof requestId !== 'string') {
    res.status(400).json({ error: 'requestId is required' });
    return;
  }
  if (!attestor || typeof attestor !== 'string') {
    res.status(400).json({ error: 'attestor is required' });
    return;
  }

  const request = recoveryRequests.get(requestId);
  if (!request) {
    res.status(404).json({ error: 'Recovery request not found' });
    return;
  }
  if (request.status !== 'pending_approval') {
    res.status(409).json({ error: `Cannot reject a request with status "${request.status}"` });
    return;
  }

  request.status = 'rejected';
  request.resolvedAt = new Date().toISOString();
  request.resolvedBy = attestor;
  request.rejectionReason = reason ?? 'No reason provided';

  console.log(`[recovery] Request ${requestId} rejected by attestor ${attestor}`);

  res.json({ success: true, message: 'Recovery request rejected.' });
});

export default router;
