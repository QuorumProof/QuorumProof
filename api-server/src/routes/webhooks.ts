import { Router, Request, Response } from 'express';
import {
  registerWebhook,
  listWebhooks,
  getWebhook,
  deleteWebhook,
  getDeliveryLog,
  listDeadLetters,
  replayDeadLetter,
  type WebhookEvent,
} from '../services/webhooks.js';
import { validateWebhookUrl, WebhookUrlValidationError } from '../services/webhookUrl.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const VALID_EVENTS: WebhookEvent[] = ['credential_issued', 'credential_attested', 'credential_revoked'];

// POST /api/webhooks — register a new webhook
router.post('/', async (req: Request, res: Response) => {
  const { url, events, secret } = req.body as { url?: unknown; events?: unknown; secret?: unknown };

  if (typeof url !== 'string' || !url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }
  try {
    await validateWebhookUrl(url);
  } catch (err: unknown) {
    if (!(err instanceof WebhookUrlValidationError)) throw err;
    res.status(400).json({ error: err.message });
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

  const reg = await registerWebhook(url, events as WebhookEvent[], typeof secret === 'string' ? secret : undefined);
  res.status(201).json(reg);
});

// GET /api/webhooks — list all webhooks
router.get('/', async (_req: Request, res: Response) => {
  res.json({ data: await listWebhooks() });
});

// GET /api/webhooks/deliveries/log — delivery log (must be before /:id)
router.get('/deliveries/log', async (_req: Request, res: Response) => {
  res.json({ data: await getDeliveryLog() });
});

// GET /api/webhooks/dead-letters — list deliveries that exhausted retries (must be before /:id)
router.get('/dead-letters', async (_req: Request, res: Response) => {
  res.json({ data: await listDeadLetters() });
});

// POST /api/webhooks/dead-letters/:id/replay — re-queue a dead-lettered delivery
router.post('/dead-letters/:id/replay', async (req: Request, res: Response) => {
  const record = await replayDeadLetter(req.params.id as string);
  if (!record) {
    res.status(404).json({ error: 'Dead-lettered delivery not found' });
    return;
  }
  res.status(202).json(record);
});

// GET /api/webhooks/:id — get a single webhook
router.get('/:id', async (req: Request, res: Response) => {
  const reg = await getWebhook(req.params.id as string);
  if (!reg) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  res.json(reg);
});

// DELETE /api/webhooks/:id — remove a webhook
router.delete('/:id', async (req: Request, res: Response) => {
  if (!await deleteWebhook(req.params.id as string)) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  res.status(204).end();
});

export default router;
