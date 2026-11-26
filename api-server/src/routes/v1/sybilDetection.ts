import { Router } from 'express';

const router = Router();

router.post('/check', (req, res) => {
  res.json({ isSybil: false, score: 0.01 });
});

export default router;
