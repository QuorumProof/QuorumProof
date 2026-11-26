import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  res.json({ tiers: ['basic', 'advanced', 'enterprise'] });
});

export default router;
