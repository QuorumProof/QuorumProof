import express from 'express';
import slicesRouter from './routes/slices.js';
import credentialsRouter from './routes/credentials.js';
import notificationsRouter from './routes/notifications.js';

const app = express();
app.use(express.json());

app.use('/api/slices', slicesRouter);
app.use('/api/credentials', credentialsRouter);
app.use('/api/notifications', notificationsRouter);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`QuorumProof API server listening on port ${PORT}`));

export default app;
