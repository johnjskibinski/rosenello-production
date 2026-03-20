import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import jobRoutes from './routes/jobs';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.use('/api/jobs', jobRoutes);

app.listen(env.port, () => {
  console.log(`[Server] Running on port ${env.port}`);
});
