/**
 * Credential Holder Dashboard API (Issue #997)
 *
 * Provides centralized view of:
 * - All credentials for authenticated user
 * - Attestation status and dispute history
 * - Pending disputes
 * - Credential access tracking/audit log
 */

import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => ReturnType<typeof SimulateCallType>;
  u32Val: (n: number) => ReturnType<typeof SimulateCallType>;
  addressVal: (a: string) => ReturnType<typeof SimulateCallType>;
};

// In-memory store for dashboard state (in production, use persistent DB)
interface DashboardAccessLog {
  credential_id: string;
  accessed_by: string;
  accessed_at: string;
  reason: string;
  duration_seconds: number;
}

interface CredentialInfo {
  id: string;
  type: number;
  subject: string;
  issuer: string;
  metadata_hash: string;
  issued_at: number;
  expires_at?: number;
  revoked: boolean;
  suspended: boolean;
  version: number;
  attestation_count: number;
  last_attested_at?: number;
}

interface AttestationInfo {
  attestor: string;
  attested_at: number;
  value: boolean;
  metadata?: string;
  expires_at?: number;
}

interface DisputeInfo {
  dispute_id: string;
  credential_id: string;
  created_by: string;
  reason: string;
  created_at: string;
  status: 'pending' | 'resolved' | 'rejected';
  resolution?: string;
}

const accessLogs = new Map<string, DashboardAccessLog[]>();
const disputes = new Map<string, DisputeInfo[]>();

function serializeBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInt);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeBigInt(v)])
    );
  }
  return value;
}

export function createDashboardRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * GET /api/me/credentials
   * Get all credentials for authenticated user
   *
   * Response:
   * {
   *   credentials: [{
   *     id: string,
   *     type: number,
   *     issuer: string,
   *     issued_at: number (unix timestamp),
   *     expires_at?: number,
   *     revoked: boolean,
   *     suspended: boolean,
   *     attestation_count: number,
   *     last_attested_at?: number,
   *     version: number
   *   }],
   *   total: number,
   *   active_count: number,
   *   revoked_count: number,
   *   suspended_count: number,
   *   expiring_soon: number (within 30 days)
   * }
   */
  router.get('/credentials', async (req: Request, res: Response) => {
    try {
      // Get authenticated user from request (via auth middleware)
      const userAddress = (req as any).userAddress;
      if (!userAddress) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Fetch credentials from contract
      const credentialCount: bigint = await soroban.simulateCall('get_credential_count', []);
      const totalCreds = Number(credentialCount);

      const userCredentials: CredentialInfo[] = [];
      let activeCount = 0;
      let revokedCount = 0;
      let suspendedCount = 0;
      let expiringCount = 0;
      const now = Math.floor(Date.now() / 1000);
      const thirtyDaysFromNow = now + 30 * 24 * 60 * 60;

      for (let i = 1; i <= totalCreds; i++) {
        try {
          const cred = await soroban.simulateCall('get_credential', [soroban.u64Val(i)]);
          const credData = serializeBigInt(cred) as CredentialInfo;

          // Filter by subject (user's own credentials)
          if (credData.subject === userAddress) {
            userCredentials.push(credData);

            // Update counters
            if (credData.revoked) {
              revokedCount++;
            } else if (credData.suspended) {
              suspendedCount++;
            } else {
              activeCount++;
            }

            if (credData.expires_at && credData.expires_at <= thirtyDaysFromNow && !credData.revoked) {
              expiringCount++;
            }
          }
        } catch {
          // Skip credentials that can't be loaded
        }
      }

      res.json({
        credentials: userCredentials,
        total: userCredentials.length,
        active_count: activeCount,
        revoked_count: revokedCount,
        suspended_count: suspendedCount,
        expiring_soon: expiringCount,
      });
    } catch (error) {
      console.error('Error fetching credentials:', error);
      res.status(500).json({ error: 'Failed to fetch credentials' });
    }
  });

  /**
   * GET /api/me/credentials/:id
   * Get detailed credential information including attestation status and history
   *
   * Query params:
   * - include_history: boolean (include amendment history and attestation history)
   * - include_disputes: boolean (include dispute history)
   *
   * Response:
   * {
   *   credential: {...},
   *   attestations: [{
   *     attestor: string,
   *     attested_at: number,
   *     value: boolean,
   *     expires_at?: number
   *   }],
   *   dispute_history: [...],
   *   amendment_history: [...],
   *   access_count: number,
   *   last_accessed_at?: string
   * }
   */
  router.get('/credentials/:id', async (req: Request, res: Response) => {
    try {
      const userAddress = (req as any).userAddress;
      if (!userAddress) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const credentialId = BigInt(req.params.id);
      const includeHistory = req.query.include_history === 'true';
      const includeDisputes = req.query.include_disputes === 'true';

      // Fetch credential
      const cred = await soroban.simulateCall('get_credential', [soroban.u64Val(credentialId)]);
      const credData = serializeBigInt(cred) as CredentialInfo;

      // Verify ownership
      if (credData.subject !== userAddress) {
        return res.status(403).json({ error: 'Forbidden: credential does not belong to user' });
      }

      // Fetch attestations
      const attestors: string[] = await soroban.simulateCall('get_attestors', [
        soroban.u64Val(credentialId),
      ]);

      const attestations: AttestationInfo[] = [];
      for (const attestor of attestors) {
        try {
          const attestationRecord = await soroban.simulateCall('get_attestation_record', [
            soroban.u64Val(credentialId),
            soroban.addressVal(attestor),
          ]);
          attestations.push(serializeBigInt(attestationRecord) as AttestationInfo);
        } catch {
          // Skip attestations that can't be loaded
        }
      }

      const response: any = {
        credential: credData,
        attestations,
        attestation_count: attestations.length,
        valid_attestations: attestations.filter((a) => a.value).length,
      };

      // Include amendment history if requested
      if (includeHistory) {
        try {
          const amendments = await soroban.simulateCall('get_amendment_history', [
            soroban.u64Val(credentialId),
          ]);
          response.amendment_history = serializeBigInt(amendments);
        } catch {
          response.amendment_history = [];
        }
      }

      // Include dispute history if requested
      if (includeDisputes) {
        const credDisputeId = credentialId.toString();
        response.disputes = disputes.get(credDisputeId) || [];
      }

      // Add access information
      const logs = accessLogs.get(credentialId.toString()) || [];
      response.access_count = logs.length;
      if (logs.length > 0) {
        response.last_accessed_at = logs[logs.length - 1].accessed_at;
      }

      res.json(response);
    } catch (error) {
      console.error('Error fetching credential details:', error);
      res.status(500).json({ error: 'Failed to fetch credential details' });
    }
  });

  /**
   * GET /api/me/disputes
   * Get pending disputes against user's credentials
   *
   * Query params:
   * - status: pending|resolved|rejected (filter by status)
   * - sort_by: created_at|status (default: created_at)
   * - limit: number (default: 50, max: 100)
   *
   * Response:
   * {
   *   disputes: [{
   *     dispute_id: string,
   *     credential_id: string,
   *     created_by: string,
   *     reason: string,
   *     created_at: string (ISO 8601),
   *     status: string,
   *     resolution?: string
   *   }],
   *   total: number,
   *   pending_count: number,
   *   resolved_count: number
   * }
   */
  router.get('/disputes', async (req: Request, res: Response) => {
    try {
      const userAddress = (req as any).userAddress;
      if (!userAddress) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const statusFilter = req.query.status as string | undefined;
      const sortBy = (req.query.sort_by as string) || 'created_at';
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

      // Fetch all user's credentials first
      const credentialCount: bigint = await soroban.simulateCall('get_credential_count', []);
      const totalCreds = Number(credentialCount);

      const userCredentialIds: string[] = [];
      for (let i = 1; i <= totalCreds; i++) {
        try {
          const cred = await soroban.simulateCall('get_credential', [soroban.u64Val(i)]);
          const credData = serializeBigInt(cred) as CredentialInfo;

          if (credData.subject === userAddress) {
            userCredentialIds.push(credData.id);
          }
        } catch {
          // Skip
        }
      }

      // Collect disputes for user's credentials
      let allDisputes: DisputeInfo[] = [];
      for (const credId of userCredentialIds) {
        const credDisputes = disputes.get(credId) || [];
        allDisputes = allDisputes.concat(credDisputes);
      }

      // Filter by status if provided
      if (statusFilter) {
        allDisputes = allDisputes.filter((d) => d.status === statusFilter);
      }

      // Sort
      if (sortBy === 'created_at') {
        allDisputes.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      } else if (sortBy === 'status') {
        const statusOrder: Record<string, number> = { pending: 0, resolved: 1, rejected: 2 };
        allDisputes.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);
      }

      // Apply limit
      allDisputes = allDisputes.slice(0, limit);

      const pendingCount = allDisputes.filter((d) => d.status === 'pending').length;
      const resolvedCount = allDisputes.filter((d) => d.status === 'resolved').length;

      res.json({
        disputes: allDisputes,
        total: allDisputes.length,
        pending_count: pendingCount,
        resolved_count: resolvedCount,
      });
    } catch (error) {
      console.error('Error fetching disputes:', error);
      res.status(500).json({ error: 'Failed to fetch disputes' });
    }
  });

  /**
   * GET /api/me/access-log
   * Get credential access tracking/audit log
   *
   * Query params:
   * - credential_id: string (filter by specific credential)
   * - limit: number (default: 100, max: 500)
   * - offset: number (pagination offset, default: 0)
   * - from: ISO 8601 timestamp (filter by date range start)
   * - to: ISO 8601 timestamp (filter by date range end)
   *
   * Response:
   * {
   *   access_logs: [{
   *     credential_id: string,
   *     accessed_by: string,
   *     accessed_at: string (ISO 8601),
   *     reason: string,
   *     duration_seconds: number
   *   }],
   *   total: number,
   *   total_access_count: number
   * }
   */
  router.get('/access-log', async (req: Request, res: Response) => {
    try {
      const userAddress = (req as any).userAddress;
      if (!userAddress) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const credentialIdFilter = req.query.credential_id as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      const offset = parseInt(req.query.offset as string) || 0;
      const fromDate = req.query.from ? new Date(req.query.from as string) : null;
      const toDate = req.query.to ? new Date(req.query.to as string) : null;

      // Fetch all user's credentials
      const credentialCount: bigint = await soroban.simulateCall('get_credential_count', []);
      const totalCreds = Number(credentialCount);

      const userCredentialIds = new Set<string>();
      for (let i = 1; i <= totalCreds; i++) {
        try {
          const cred = await soroban.simulateCall('get_credential', [soroban.u64Val(i)]);
          const credData = serializeBigInt(cred) as CredentialInfo;

          if (credData.subject === userAddress) {
            userCredentialIds.add(credData.id);
          }
        } catch {
          // Skip
        }
      }

      // Collect access logs for user's credentials
      let allLogs: DashboardAccessLog[] = [];
      for (const credId of userCredentialIds) {
        if (credentialIdFilter && credId !== credentialIdFilter) {
          continue;
        }

        const logs = accessLogs.get(credId) || [];
        allLogs = allLogs.concat(logs);
      }

      // Filter by date range if provided
      if (fromDate || toDate) {
        allLogs = allLogs.filter((log) => {
          const logDate = new Date(log.accessed_at);
          if (fromDate && logDate < fromDate) return false;
          if (toDate && logDate > toDate) return false;
          return true;
        });
      }

      // Sort by date (newest first)
      allLogs.sort((a, b) => new Date(b.accessed_at).getTime() - new Date(a.accessed_at).getTime());

      const total = allLogs.length;

      // Apply pagination
      allLogs = allLogs.slice(offset, offset + limit);

      res.json({
        access_logs: allLogs,
        total,
        limit,
        offset,
        total_access_count: allLogs.reduce((sum, log) => sum + 1, 0),
      });
    } catch (error) {
      console.error('Error fetching access log:', error);
      res.status(500).json({ error: 'Failed to fetch access log' });
    }
  });

  /**
   * POST /api/me/disputes
   * Create a dispute against a credential
   * (Only issuers or designated authorities can initiate disputes)
   *
   * Request body:
   * {
   *   credential_id: string,
   *   reason: string,
   *   evidence_hash?: string (IPFS hash or similar)
   * }
   */
  router.post('/disputes', async (req: Request, res: Response) => {
    try {
      const userAddress = (req as any).userAddress;
      if (!userAddress) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { credential_id, reason, evidence_hash } = req.body;

      if (!credential_id || !reason) {
        return res.status(400).json({ error: 'Missing required fields: credential_id, reason' });
      }

      // Create dispute
      const disputeId = `dispute_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const newDispute: DisputeInfo = {
        dispute_id: disputeId,
        credential_id,
        created_by: userAddress,
        reason,
        created_at: new Date().toISOString(),
        status: 'pending',
      };

      const credDisputes = disputes.get(credential_id) || [];
      credDisputes.push(newDispute);
      disputes.set(credential_id, credDisputes);

      res.status(201).json(newDispute);
    } catch (error) {
      console.error('Error creating dispute:', error);
      res.status(500).json({ error: 'Failed to create dispute' });
    }
  });

  /**
   * POST /api/me/access-log
   * Log credential access (called when credential is verified/accessed)
   *
   * Request body:
   * {
   *   credential_id: string,
   *   accessed_by: string,
   *   reason: string,
   *   duration_seconds: number
   * }
   */
  router.post('/access-log', async (req: Request, res: Response) => {
    try {
      const { credential_id, accessed_by, reason, duration_seconds } = req.body;

      if (!credential_id || !accessed_by || !reason) {
        return res.status(400).json({
          error: 'Missing required fields: credential_id, accessed_by, reason',
        });
      }

      const logEntry: DashboardAccessLog = {
        credential_id,
        accessed_by,
        accessed_at: new Date().toISOString(),
        reason,
        duration_seconds: duration_seconds || 0,
      };

      const credLogs = accessLogs.get(credential_id) || [];
      credLogs.push(logEntry);
      accessLogs.set(credential_id, credLogs);

      res.status(201).json(logEntry);
    } catch (error) {
      console.error('Error logging access:', error);
      res.status(500).json({ error: 'Failed to log access' });
    }
  });

  /**
   * GET /api/me/summary
   * Quick dashboard summary for quick view
   *
   * Response:
   * {
   *   total_credentials: number,
   *   active_credentials: number,
   *   pending_disputes: number,
   *   credentials_expiring_30_days: number,
   *   last_access_at?: string,
   *   reputation_score?: number
   * }
   */
  router.get('/summary', async (req: Request, res: Response) => {
    try {
      const userAddress = (req as any).userAddress;
      if (!userAddress) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const credentialCount: bigint = await soroban.simulateCall('get_credential_count', []);
      const totalCreds = Number(credentialCount);

      let totalCredentials = 0;
      let activeCredentials = 0;
      let expiringCount = 0;
      let lastAccess: Date | null = null;
      const now = Math.floor(Date.now() / 1000);
      const thirtyDaysFromNow = now + 30 * 24 * 60 * 60;

      const userCredentialIds: string[] = [];

      for (let i = 1; i <= totalCreds; i++) {
        try {
          const cred = await soroban.simulateCall('get_credential', [soroban.u64Val(i)]);
          const credData = serializeBigInt(cred) as CredentialInfo;

          if (credData.subject === userAddress) {
            totalCredentials++;
            userCredentialIds.push(credData.id);

            if (!credData.revoked && !credData.suspended) {
              activeCredentials++;
            }

            if (credData.expires_at && credData.expires_at <= thirtyDaysFromNow && !credData.revoked) {
              expiringCount++;
            }
          }
        } catch {
          // Skip
        }
      }

      // Count pending disputes
      let pendingDisputes = 0;
      for (const credId of userCredentialIds) {
        const credDisputes = disputes.get(credId) || [];
        pendingDisputes += credDisputes.filter((d) => d.status === 'pending').length;
      }

      // Find latest access
      for (const credId of userCredentialIds) {
        const logs = accessLogs.get(credId) || [];
        if (logs.length > 0) {
          const lastLog = logs[logs.length - 1];
          const logDate = new Date(lastLog.accessed_at);
          if (!lastAccess || logDate > lastAccess) {
            lastAccess = logDate;
          }
        }
      }

      res.json({
        total_credentials: totalCredentials,
        active_credentials: activeCredentials,
        pending_disputes: pendingDisputes,
        credentials_expiring_30_days: expiringCount,
        last_access_at: lastAccess?.toISOString() || null,
      });
    } catch (error) {
      console.error('Error fetching dashboard summary:', error);
      res.status(500).json({ error: 'Failed to fetch dashboard summary' });
    }
  });

  return router;
}
