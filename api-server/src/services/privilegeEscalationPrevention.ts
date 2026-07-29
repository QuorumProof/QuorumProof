import { logger } from './logger.js';

interface PrivilegeChangeAuditLog {
  userId: string;
  previousRole: string;
  newRole: string;
  timestamp: string;
  requester: string;
  mfaVerified: boolean;
  approvals: string[];
  status: 'pending' | 'approved' | 'rejected' | 'completed';
}

interface MFAChallenge {
  userId: string;
  method: string;
  code: string;
  expiresAt: number;
  attempts: number;
}

interface PrivilegeChangeRequest {
  userId: string;
  newRole: string;
  reason?: string;
  mfaVerified?: boolean;
  approvalRequired?: boolean;
}

class PrivilegeEscalationManager {
  private auditLog: PrivilegeChangeAuditLog[] = [];
  private mfaChallenges: Map<string, MFAChallenge> = new Map();
  private pendingApprovals: Map<string, PrivilegeChangeRequest> = new Map();
  private readonly MFA_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private readonly MFA_MAX_ATTEMPTS = 3;
  private readonly ADMIN_ROLES = ['admin', 'superadmin'];

  logPrivilegeChange(
    userId: string,
    previousRole: string,
    newRole: string,
    requester: string,
    mfaVerified: boolean = false,
  ): PrivilegeChangeAuditLog {
    const entry: PrivilegeChangeAuditLog = {
      userId,
      previousRole,
      newRole,
      timestamp: new Date().toISOString(),
      requester,
      mfaVerified,
      approvals: [],
      status: 'pending',
    };

    this.auditLog.push(entry);

    logger.warn(
      `Privilege change requested for user ${userId}`,
      'privilege-escalation',
      {
        userId,
        previousRole,
        newRole,
        requester,
        mfaVerified,
      },
    );

    return entry;
  }

  requireMFAForEscalation(userId: string): MFAChallenge {
    const code = Math.random().toString().slice(2, 8).padEnd(6, '0');
    const challenge: MFAChallenge = {
      userId,
      method: 'totp',
      code,
      expiresAt: Date.now() + this.MFA_TIMEOUT,
      attempts: 0,
    };

    this.mfaChallenges.set(userId, challenge);

    logger.info(
      `MFA challenge issued for privilege escalation`,
      'privilege-escalation',
      { userId, expiresAt: new Date(challenge.expiresAt).toISOString() },
    );

    return challenge;
  }

  verifyMFACode(userId: string, code: string): boolean {
    const challenge = this.mfaChallenges.get(userId);

    if (!challenge) {
      logger.warn(`MFA verification attempted without active challenge`, 'privilege-escalation', { userId });
      return false;
    }

    if (Date.now() > challenge.expiresAt) {
      this.mfaChallenges.delete(userId);
      logger.warn(`MFA code expired`, 'privilege-escalation', { userId });
      return false;
    }

    challenge.attempts++;

    if (challenge.attempts > this.MFA_MAX_ATTEMPTS) {
      this.mfaChallenges.delete(userId);
      logger.error(`MFA maximum attempts exceeded`, 'privilege-escalation', { userId, attempts: challenge.attempts });
      return false;
    }

    const isValid = challenge.code === code;

    if (isValid) {
      this.mfaChallenges.delete(userId);
      logger.info(`MFA verification successful`, 'privilege-escalation', { userId });
    } else {
      logger.warn(`MFA verification failed`, 'privilege-escalation', { userId, attempt: challenge.attempts });
    }

    return isValid;
  }

  requireApprovalForAdminRole(userId: string): boolean {
    return true; // Admin role assignment always requires approval
  }

  submitApprovalRequest(
    userId: string,
    newRole: string,
    approvers: string[],
    reason?: string,
  ): string {
    const requestId = `priv-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    this.pendingApprovals.set(requestId, {
      userId,
      newRole,
      reason,
      mfaVerified: false,
      approvalRequired: true,
    });

    logger.info(
      `Approval request submitted for privilege change`,
      'privilege-escalation',
      {
        requestId,
        userId,
        newRole,
        approvers,
      },
    );

    return requestId;
  }

  approvePrivilegeChange(requestId: string, approverId: string): boolean {
    const request = this.pendingApprovals.get(requestId);

    if (!request) {
      logger.warn(`Approval request not found`, 'privilege-escalation', { requestId });
      return false;
    }

    logger.info(
      `Privilege change approved`,
      'privilege-escalation',
      {
        requestId,
        userId: request.userId,
        newRole: request.newRole,
        approverId,
      },
    );

    return true;
  }

  rejectPrivilegeChange(requestId: string, approverId: string, reason?: string): boolean {
    const request = this.pendingApprovals.get(requestId);

    if (!request) {
      logger.warn(`Approval request not found for rejection`, 'privilege-escalation', { requestId });
      return false;
    }

    this.pendingApprovals.delete(requestId);

    logger.warn(
      `Privilege change rejected`,
      'privilege-escalation',
      {
        requestId,
        userId: request.userId,
        newRole: request.newRole,
        approverId,
        reason,
      },
    );

    return true;
  }

  getAuditLog(userId?: string, limit: number = 100): PrivilegeChangeAuditLog[] {
    let logs = this.auditLog;

    if (userId) {
      logs = logs.filter(log => log.userId === userId);
    }

    return logs.slice(-limit);
  }

  getPendingApprovals(): Array<{ requestId: string; request: PrivilegeChangeRequest }> {
    return Array.from(this.pendingApprovals.entries()).map(([requestId, request]) => ({
      requestId,
      request,
    }));
  }
}

const privilegeEscalationManager = new PrivilegeEscalationManager();

export { privilegeEscalationManager, PrivilegeEscalationManager, PrivilegeChangeAuditLog, MFAChallenge };
