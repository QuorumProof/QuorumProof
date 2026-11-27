import { Router } from 'express';

const router = Router();

router.post('/transfer', (req, res) => {
  res.status(202).json({ transferId: 'bridge-tx-1' });
});

router.get('/status/:id', (req, res) => {
  res.json({ id: req.params.id, state: 'completed' });
});

export default router;
