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

const router = Router();

router.put('/preferences', validate(schemas.notificationPreferences), (req: Request, res: Response) => {
  const body = req.body as NotificationPreferences;

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
    channels: body.channels,
    events: body.events,
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

router.post('/send', validate(schemas.notificationSend), async (req: Request, res: Response) => {
  const { address, event, credential_id, issuer, holder } = req.body as {
    address: string;
    event: NotificationEvent;
    credential_id: number;
    issuer?: string;
    holder?: string;
  };

  const wsRecipients = broadcastEvent({
    type: event as string,
    credential_id,
    issuer,
    holder,
    timestamp: new Date().toISOString(),
  });

  await dispatchNotification(address, event, credential_id);
  res.json({ success: true, ws_recipients: wsRecipients });
});

export default router;
