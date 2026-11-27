import { Router } from 'express';

const router = Router();

router.get('/:id', (req, res) => {
  res.json({ credentialId: req.params.id, revoked: false });
});

export default router;
