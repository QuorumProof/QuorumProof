import express, { Request, Response, NextFunction } from 'express';
import slicesRouter from './routes/slices.js';
import credentialsRouter from './routes/credentials.js';
import reportsRouter from './routes/reports.js';
import { recordCall } from './analytics.js';

const app = express();
app.use(express.json());

// #585: track every /api/* call by route path and record errors
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const fn = `${req.method} ${req.path}`;
  res.on('finish', () => recordCall(fn, res.statusCode >= 500));
  next();
});

app.use('/api/slices', slicesRouter);
app.use('/api/credentials', credentialsRouter);
app.use('/api/reports', reportsRouter);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`QuorumProof API server listening on port ${PORT}`));

export default app;
