/**
 * Identifies this process among API server replicas. Used to tag pub/sub
 * messages and metrics so cross-instance delivery can be distinguished from
 * same-instance delivery, and so per-instance metrics can be aggregated.
 *
 * Set WS_INSTANCE_ID explicitly in deployments (e.g. to the pod name) so
 * instance identity is stable and human-readable; otherwise a random id is
 * generated per process.
 */
import { randomUUID } from 'crypto';

export const instanceId: string = process.env.WS_INSTANCE_ID ?? randomUUID();
