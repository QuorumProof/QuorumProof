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

const router = Router();

const VALID_CHANNELS = new Set(['email', 'sms']);
const VALID_EVENTS = new Set<NotificationEvent>([
  'credential_issued',
  'credential_revoked',
  'credential_suspended',
  'credential_attested',
  'credential_expiring',
]);

router.put('/preferences', (req: Request, res: Response) => {
  const body = req.body as Partial<NotificationPreferences>;

  if (!body.address || typeof body.address !== 'string') {
    res.status(400).json({ error: 'address is required' });
    return;
  }
  if (!Array.isArray(body.channels) || body.channels.some((c) => !VALID_CHANNELS.has(c))) {
    res.status(400).json({ error: 'channels must be an array of "email" and/or "sms"' });
    return;
  }
  if (!Array.isArray(body.events) || body.events.some((e) => !VALID_EVENTS.has(e as NotificationEvent))) {
    res.status(400).json({ error: `events must be an array of valid event types` });
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

  setPreferences({
    address: body.address,
    email: body.email,
    phone: body.phone,
    channels: body.channels as NotificationPreferences['channels'],
    events: body.events as NotificationEvent[],
    enabled: body.enabled !== false,
  });

  res.json({ success: true });
});

router.get('/preferences/:address', (req: Request, res: Response) => {
  const prefs = getPreferences(req.params.address);
  if (!prefs) {
    res.status(404).json({ error: 'No preferences found for this address' });
    return;
  }
  res.json(prefs);
});

router.get('/history', (req: Request, res: Response) => {
  const address = typeof req.query.address === 'string' ? req.query.address : undefined;
  res.json({ data: getHistory(address) });
});

router.post('/send', async (req: Request, res: Response) => {
  const { address, event, credential_id } = req.body as {
    address?: unknown;
    event?: unknown;
    credential_id?: unknown;
  };

  if (typeof address !== 'string') {
    res.status(400).json({ error: 'address is required' });
    return;
  }
  if (typeof event !== 'string' || !VALID_EVENTS.has(event as NotificationEvent)) {
    res.status(400).json({ error: 'valid event is required' });
    return;
  }
  if (typeof credential_id !== 'number' || !Number.isInteger(credential_id) || credential_id <= 0) {
    res.status(400).json({ error: 'credential_id must be a positive integer' });
    return;
  }

  const wsRecipients = broadcastEvent({
    type: event as string,
    credential_id: credential_id as number,
    issuer: req.body.issuer as string | undefined,
    holder: req.body.holder as string | undefined,
    timestamp: new Date().toISOString(),
  });

  await dispatchNotification(address, event as NotificationEvent, credential_id);
  res.json({ success: true, ws_recipients: wsRecipients });
});

export default router;
