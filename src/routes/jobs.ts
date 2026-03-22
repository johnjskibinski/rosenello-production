import { Router } from 'express';
import { syncActiveJobs } from '../services/lpSync';
import { supabase } from '../lib/supabase';
import { lpPost, getLPToken } from '../lib/lpClient';

const router = Router();

router.get('/lptest', async (_, res) => {
  try {
    const token = await getLPToken();
    res.json({ token: token.slice(0, 20) + '...', length: token.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/lpraw', async (_, res) => {
  try {
    const today = new Date();
    const start = new Date();
    start.setDate(today.getDate() - 30);

    const fmt = (d: Date) =>
      `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;

    const data = await lpPost('Customers/GetJobStatusChanges', {
      startdate: fmt(start),
      enddate: fmt(today),
      cst_id: '0',
      job_id: '0',
      jbs_id: '',
      format: '1',
      options: '0',
      sortorder: '1',
      PageSize: '25',
      StartIndex: '1',
    });

    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', async (_, res) => {
  try {
    const result = await syncActiveJobs();
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (_, res) => {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .order('last_synced_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/:lp_job_id/status', async (req, res) => {
  const { lp_job_id } = req.params;
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  const { data, error } = await supabase
    .from('jobs')
    .update({ lp_status: status, last_synced_at: new Date().toISOString() })
    .eq('lp_job_id', lp_job_id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
