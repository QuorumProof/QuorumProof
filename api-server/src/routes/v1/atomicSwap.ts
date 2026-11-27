import { Router } from 'express';

const router = Router();

router.post('/', (req, res) => {
  res.status(201).json({ status: 'initiated', swapId: 'swap-123' });
});

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id, status: 'pending' });
});

export default router;
