import { Router } from 'express';

const router = Router();

router.post('/', (req, res) => {
  res.status(201).json({ puzzleId: 'puzzle-1' });
});

export default router;
