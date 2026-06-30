import { Router, Request, Response } from 'express';
import {
  registerWebhook,
  listWebhooks,
  getWebhook,
  deleteWebhook,
  getDeliveryLog,
  type WebhookEvent,
} from '../services/webhooks.js';

const router = Router();

const VALID_EVENTS: WebhookEvent[] = ['credential_issued', 'credential_attested', 'credential_revoked'];

// POST /api/webhooks — register a new webhook
router.post('/', (req: Request, res: Response) => {
  const { url, events, secret } = req.body as { url?: unknown; events?: unknown; secret?: unknown };

  if (typeof url !== 'string' || !url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }
  if (!Array.isArray(events) || events.length === 0) {
    res.status(400).json({ error: 'events must be a non-empty array' });
    return;
  }
  const invalid = (events as unknown[]).filter(e => !VALID_EVENTS.includes(e as WebhookEvent));
  if (invalid.length > 0) {
    res.status(400).json({ error: `invalid events: ${invalid.join(', ')}. Valid: ${VALID_EVENTS.join(', ')}` });
    return;
  }

  const reg = registerWebhook(url, events as WebhookEvent[], typeof secret === 'string' ? secret : undefined);
  res.status(201).json(reg);
});

// GET /api/webhooks — list all webhooks
router.get('/', (_req: Request, res: Response) => {
  res.json({ data: listWebhooks() });
});

// GET /api/webhooks/deliveries/log — delivery log (must be before /:id)
router.get('/deliveries/log', (_req: Request, res: Response) => {
  res.json({ data: getDeliveryLog() });
});

// GET /api/webhooks/:id — get a single webhook
router.get('/:id', (req: Request, res: Response) => {
  const reg = getWebhook(req.params.id);
  if (!reg) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  res.json(reg);
});

// DELETE /api/webhooks/:id — remove a webhook
router.delete('/:id', (req: Request, res: Response) => {
  if (!deleteWebhook(req.params.id)) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  res.status(204).end();
});

export default router;
