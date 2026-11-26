import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  res.json({ gasCost: '21000', usdEstimate: '0.50' });
});

export default router;
