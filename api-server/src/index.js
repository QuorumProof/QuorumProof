import express from 'express';
import { router as credentialsRouter } from './credentials.js';

const app = express();
app.use(express.json());
app.use('/api/credentials', credentialsRouter);

export default app;

// Start server only when run directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const PORT = process.env.PORT ?? 3001;
  app.listen(PORT, () => console.log(`QuorumProof API listening on :${PORT}`));
}
