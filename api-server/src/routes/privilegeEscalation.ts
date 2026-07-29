import { Router, Request, Response } from 'express';
import { privilegeEscalationManager } from '../services/privilegeEscalationPrevention.js';
import { logger } from '../services/logger.js';

const router = Router();

// POST /api/admin/privilege-escalation/mfa-challenge - Request MFA for escalation
router.post('/mfa-challenge', (req: Request, res: Response) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    const challenge = privilegeEscalationManager.requireMFAForEscalation(userId);

    res.json({
      userId,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
      message: 'MFA challenge issued. Check your authenticator app.',
    });
  } catch (error) {
    logger.error(
      `Error requesting MFA challenge`,
      'privilege-escalation',
      { error: error instanceof Error ? error.message : String(error) },
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/privilege-escalation/verify-mfa - Verify MFA code
router.post('/verify-mfa', (req: Request, res: Response) => {
  try {
    const { userId, code } = req.body;

    if (!userId || !code) {
      res.status(400).json({ error: 'userId and code are required' });
      return;
    }

    const verified = privilegeEscalationManager.verifyMFACode(userId, code);

    if (!verified) {
      res.status(401).json({ error: 'Invalid or expired MFA code' });
      return;
    }

    res.json({ verified: true, message: 'MFA verification successful' });
  } catch (error) {
    logger.error(
      `Error verifying MFA code`,
      'privilege-escalation',
      { error: error instanceof Error ? error.message : String(error) },
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/privilege-escalation/request - Submit privilege change request
router.post('/request', (req: Request, res: Response) => {
  try {
    const { userId, newRole, reason, approvers } = req.body;

    if (!userId || !newRole) {
      res.status(400).json({ error: 'userId and newRole are required' });
      return;
    }

    const requestId = privilegeEscalationManager.submitApprovalRequest(
      userId,
      newRole,
      approvers || [],
      reason,
    );

    res.json({
      requestId,
      status: 'pending',
      message: 'Privilege escalation request submitted for approval',
    });
  } catch (error) {
    logger.error(
      `Error submitting privilege escalation request`,
      'privilege-escalation',
      { error: error instanceof Error ? error.message : String(error) },
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/privilege-escalation/approve - Approve a privilege change
router.post('/approve', (req: Request, res: Response) => {
  try {
    const { requestId, approverId } = req.body;

    if (!requestId || !approverId) {
      res.status(400).json({ error: 'requestId and approverId are required' });
      return;
    }

    const approved = privilegeEscalationManager.approvePrivilegeChange(requestId, approverId);

    if (!approved) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }

    res.json({ approved: true, message: 'Privilege escalation approved' });
  } catch (error) {
    logger.error(
      `Error approving privilege escalation`,
      'privilege-escalation',
      { error: error instanceof Error ? error.message : String(error) },
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/privilege-escalation/reject - Reject a privilege change
router.post('/reject', (req: Request, res: Response) => {
  try {
    const { requestId, approverId, reason } = req.body;

    if (!requestId || !approverId) {
      res.status(400).json({ error: 'requestId and approverId are required' });
      return;
    }

    const rejected = privilegeEscalationManager.rejectPrivilegeChange(requestId, approverId, reason);

    if (!rejected) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }

    res.json({ rejected: true, message: 'Privilege escalation rejected' });
  } catch (error) {
    logger.error(
      `Error rejecting privilege escalation`,
      'privilege-escalation',
      { error: error instanceof Error ? error.message : String(error) },
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/privilege-escalation/audit-log - Get audit log
router.get('/audit-log', (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 100;

    const auditLog = privilegeEscalationManager.getAuditLog(userId, limit);

    res.json({
      total: auditLog.length,
      logs: auditLog,
    });
  } catch (error) {
    logger.error(
      `Error fetching audit log`,
      'privilege-escalation',
      { error: error instanceof Error ? error.message : String(error) },
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/privilege-escalation/pending - Get pending approvals
router.get('/pending', (req: Request, res: Response) => {
  try {
    const pending = privilegeEscalationManager.getPendingApprovals();

    res.json({
      total: pending.length,
      requests: pending,
    });
  } catch (error) {
    logger.error(
      `Error fetching pending approvals`,
      'privilege-escalation',
      { error: error instanceof Error ? error.message : String(error) },
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
