import express from 'express';
import slicesRouter from './routes/slices.js';

const app = express();
app.use(express.json());

app.use('/api/slices', slicesRouter);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`QuorumProof API server listening on port ${PORT}`));

export default app;
