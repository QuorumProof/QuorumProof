import { Router } from 'express';

const router = Router();

router.post('/challenge', (req, res) => {
  res.json({ status: 'ok', challenge: 'sample-challenge' });
});

router.post('/verify', (req, res) => {
  res.json({ status: 'ok', token: 'sample-token' });
});

export default router;
