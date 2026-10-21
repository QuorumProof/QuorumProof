import { Router, Request, Response } from 'express';
import {
  setPreferences,
  getPreferences,
  getHistory,
  dispatchNotification,
  type NotificationPreferences,
  type NotificationEvent,
} from '../notifications.js';
import { broadcastEvent } from '../ws/server.js';
import { validate, schemas } from '../middleware/validate.js';
import { requireAuth, requireRole, isAdmin } from '../middleware/auth.js';

const router = Router();

/** Callers may act only on their own address; admins may act on any address. */
function isSelfOrAdmin(req: Request, address: string | undefined): boolean {
  return isAdmin(req) || (address !== undefined && req.auth?.sub === address);
}

// Preferences hold contact details (email/phone), so writes are caller-scoped too (#1749).
router.put('/preferences', requireAuth, validate(schemas.notificationPreferences), async (req: Request, res: Response) => {
  const body = req.body as NotificationPreferences;

  if (!isSelfOrAdmin(req, body.address)) {
    res.status(403).json({ error: 'Cannot change preferences for another address' });
    return;
  }
  if (body.channels.includes('email') && (!body.email || typeof body.email !== 'string')) {
    res.status(400).json({ error: 'email is required when email channel is enabled' });
    return;
  }
  if (body.channels.includes('sms') && (!body.phone || typeof body.phone !== 'string')) {
    res.status(400).json({ error: 'phone is required when sms channel is enabled' });
    return;
  }

  try {
    await setPreferences({
      address: body.address,
      email: body.email,
      phone: body.phone,
      channels: body.channels,
      events: body.events,
      credential_type_filters: body.credential_type_filters,
      enabled: body.enabled !== false,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Preferences for one address: only that address or an admin (#1749).
router.get('/preferences/:address', requireAuth, async (req: Request, res: Response) => {
  const { address } = req.params;
  if (!isSelfOrAdmin(req, address)) {
    res.status(403).json({ error: 'Cannot read preferences for another address' });
    return;
  }
  try {
    const prefs = await getPreferences(address);
    if (!prefs) {
      res.status(404).json({ error: 'No preferences found for this address' });
      return;
    }
    res.json(prefs);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// History: non-admins see only their own notifications, regardless of the query.
router.get('/history', requireAuth, async (req: Request, res: Response) => {
  const requested = typeof req.query.address === 'string' ? req.query.address : undefined;

  let address = requested;
  if (!isAdmin(req)) {
    if (requested !== undefined && requested !== req.auth?.sub) {
      res.status(403).json({ error: 'Cannot read history for another address' });
      return;
    }
    address = req.auth?.sub;
  }

  try {
    res.json({ data: await getHistory(address) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Sending notifications pushes to WebSocket clients and email/SMS, so it is
// limited to issuers (and admins). Issuers may only send events attributed to themselves (#1749).
router.post('/send', requireRole('issuer'), validate(schemas.notificationSend), async (req: Request, res: Response) => {
  const { address, event, credential_id, credential_type, issuer, holder } = req.body as {
    address: string;
    event: NotificationEvent;
    credential_id: number;
    credential_type?: number;
    issuer?: string;
    holder?: string;
  };

  if (!isAdmin(req) && issuer !== req.auth?.sub) {
    res.status(403).json({ error: 'Issuers may only send notifications attributed to themselves' });
    return;
  }

  try {
    const wsRecipients = broadcastEvent({
      type: event as string,
      credential_id,
      issuer,
      holder,
      timestamp: new Date().toISOString(),
    });

    await dispatchNotification(address, event, credential_id, credential_type);
    res.json({ success: true, ws_recipients: wsRecipients });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
