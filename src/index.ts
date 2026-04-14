import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cron from 'node-cron';
import { env } from './config/env';
import kpiRouter from './routes/kpi';
import jobRoutes from './routes/jobs'
import calendarRouter from './routes/calendar'
import costsRouter from './routes/costs'
import reportsRouter from './routes/reports'

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.use('/api/kpi', kpiRouter);
app.use('/api/jobs', jobRoutes)
app.use('/api/calendar', calendarRouter)
app.use('/api/costs', costsRouter)
app.use('/api/reports', reportsRouter)

// Sync Mon-Fri every 4 hours between 7am-7pm (Eastern)
cron.schedule('0 7,9,11,13,15,17,19 * * 1-5', async () => {
  console.log('[Cron] Running scheduled LP sync');
  try {
    const { syncActiveJobs } = await import('./services/lpSync.js');
    const result = await syncActiveJobs();
    console.log('[Cron] Sync complete:', result);
  } catch (err) {
    console.error('[Cron] Sync failed:', err);
  }
});

app.listen(env.port, () => {
  console.log(`[Server] Running on port ${env.port}`);
});
