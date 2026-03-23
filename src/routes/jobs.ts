import { Router } from 'express';
import { syncActiveJobs } from '../services/lpSync';
import { supabase } from '../lib/supabase';
import { lpPost, getLPToken } from '../lib/lpClient';

const router = Router();

// ── Debug / test routes ──────────────────────────────────────────────────────

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
      `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

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

// ── Sync ─────────────────────────────────────────────────────────────────────

router.post('/sync', async (_, res) => {
  try {
    const result = await syncActiveJobs();
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Jobs list ─────────────────────────────────────────────────────────────────

router.get('/', async (_, res) => {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .order('last_synced_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Status update — writes to LP first, then Supabase ────────────────────────

router.patch('/:lp_job_id/status', async (req, res) => {
  const { lp_job_id } = req.params;
  const { status } = req.body;

  if (!status) return res.status(400).json({ error: 'status required' });

  // 1. Push to Lead Perfection
  try {
    await lpPost('SalesApi/UpdateSalesJobDetail', {
      jobid: lp_job_id,
      pwsid: status,
      cmtid: '',
      commission: '0',
      taxrate: '0',
      gross: '0',
    });
  } catch (lpErr: any) {
    console.error(`[status-update] LP write failed for job ${lp_job_id}:`, lpErr.message);
    return res.status(502).json({
      error: 'LP write failed — Supabase was NOT updated',
      detail: lpErr.message,
    });
  }

  // 2. Only update Supabase after LP confirms success
  const { data, error: dbErr } = await supabase
    .from('jobs')
    .update({ lp_status: status, last_synced_at: new Date().toISOString() })
    .eq('lp_job_id', lp_job_id)
    .select()
    .single();

  if (dbErr) {
    console.error(`[status-update] LP succeeded but Supabase failed for job ${lp_job_id}:`, dbErr.message);
    return res.status(500).json({
      error: 'LP updated but Supabase write failed — re-sync recommended',
      detail: dbErr.message,
    });
  }

  res.json(data);
});

export default router;

// ── Upload Docs → LP ──────────────────────────────────────────────────────────

const TAB_CONFIG: Record<string, { docTypeId: string; portrait: boolean }> = {
  'Costing':        { docTypeId: '36', portrait: false },
  'Window Measure': { docTypeId: '16', portrait: false },
  'Work Order':     { docTypeId: '26', portrait: true  },
  'Checklist':      { docTypeId: '37', portrait: true  },
  'LaborCalc':      { docTypeId: '35', portrait: true  },
}

async function uploadTabToLP(
  sheetId: string,
  tabName: string,
  gid: string,
  lpJobId: string,
  contractId: string,
  token: string
): Promise<{ tab: string; ok: boolean; error?: string }> {
  try {
    const cfg = TAB_CONFIG[tabName]
    if (!cfg) return { tab: tabName, ok: false, error: `Unknown tab: ${tabName}` }

    // Get a fresh access token from OAuth2 client
    const { google } = await import('googleapis')
    const oauth2Client = new (google.auth.OAuth2 as any)(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    )
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
    const { token: accessToken } = await oauth2Client.getAccessToken()

    // Export single tab as PDF
    const orientation = cfg.portrait ? 'true' : 'false'
    const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=pdf&gid=${gid}&portrait=${orientation}&fitw=true&size=letter&gridlines=false`

    const pdfRes = await fetch(exportUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!pdfRes.ok) throw new Error(`Drive export failed: ${pdfRes.status}`)

    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer())
    const base64Pdf = pdfBuffer.toString('base64')

    // Upload to LP
    const lpRes = await fetch('https://api.leadperfection.com/api/SalesApi/AddJobImages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id:    String(lpJobId),
        imagename: `${tabName.replace(' ', '_')}_${contractId}.pdf`,
        imagedata: base64Pdf,
        imagetype: 'application/pdf',
        doctypeid: cfg.docTypeId,
      }),
    })

    const lpText = await lpRes.text()
    let lpJson: any
    try { lpJson = JSON.parse(lpText) } catch { lpJson = { raw: lpText } }

    if (!lpRes.ok) throw new Error(lpJson?.Message || lpJson?.raw || 'LP upload failed')

    return { tab: tabName, ok: true }
  } catch (err: any) {
    return { tab: tabName, ok: false, error: err.message }
  }
}

router.post('/:lp_job_id/upload-docs/:tabName?', async (req, res) => {
  const { lp_job_id, tabName } = req.params

  try {
    // 1. Get job from Supabase
    const { data: job, error } = await supabase
      .from('jobs')
      .select('*')
      .eq('lp_job_id', lp_job_id)
      .single()

    if (error || !job) return res.status(404).json({ error: 'Job not found' })
    if (!job.measure_sheet_url) return res.status(400).json({ error: 'No measure sheet linked to this job' })

    // 2. Parse sheet ID from URL
    const match = job.measure_sheet_url.match(/\/d\/([\w-]+)/)
    if (!match) return res.status(400).json({ error: 'Could not parse sheet ID from measure_sheet_url' })
    const sheetId = match[1]

    // 3. Get tab GIDs from Sheets API
    const { google } = await import('googleapis')
    const oauth2Client = new (google.auth.OAuth2 as any)(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    )
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client })

    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties' })
    const sheetsList = meta.data.sheets || []
    const gidMap: Record<string, string> = {}
    for (const s of sheetsList) {
      const title = s.properties?.title
      const gid   = String(s.properties?.sheetId ?? '')
      if (title) gidMap[title] = gid
    }

    // 4. Decide which tabs to upload
    const tabsToUpload = tabName
      ? [tabName]
      : Object.keys(TAB_CONFIG)

    const lpToken = await getLPToken()
    const contractId = job.contract_id || String(lp_job_id)

    const results = await Promise.all(
      tabsToUpload.map(tab => {
        const gid = gidMap[tab]
        if (!gid) return Promise.resolve({ tab, ok: false, error: `Tab "${tab}" not found in sheet` })
        return uploadTabToLP(sheetId, tab, gid, lp_job_id, contractId, lpToken)
      })
    )

    const allOk = results.every(r => r.ok)

    // 5. Stamp docs_uploaded_at in Supabase if at least one succeeded
    if (results.some(r => r.ok)) {
      await supabase
        .from('jobs')
        .update({ docs_uploaded_at: new Date().toISOString() })
        .eq('lp_job_id', lp_job_id)
    }

    res.json({ ok: allOk, results })
  } catch (err: any) {
    console.error('[upload-docs] error:', err)
    res.status(500).json({ error: err.message })
  }
})
