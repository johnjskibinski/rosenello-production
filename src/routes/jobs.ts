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

  // Update Supabase directly (LP has no public API endpoint for job status updates)
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
        jobid:    Number(lpJobId),
        filename: `${tabName.replace(' ', '_')}_${contractId}.pdf`,
        filebytes: Array.from(pdfBuffer),
        dtyid:    Number(cfg.docTypeId),
        docdescr: tabName,
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

async function handleUploadDocs(req: any, res: any) {
  const lp_job_id = req.params.lp_job_id
  const tabName: string | undefined = req.params.tabName

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

    // Refresh sheet-derived data in background
    if (job.measure_sheet_url) {
      const { readProjectTotals, readWorkOrderRows } = await import('../lib/googleSheets')
      const [totals, workOrderRows] = await Promise.all([
        readProjectTotals(job.measure_sheet_url),
        readWorkOrderRows(job.measure_sheet_url),
      ])
      const sheetUpdate: any = {}
      if (totals) Object.assign(sheetUpdate, totals)
      if (workOrderRows) sheetUpdate.work_order_rows = workOrderRows
      if (Object.keys(sheetUpdate).length > 0) {
        await supabase.from('jobs').update(sheetUpdate).eq('lp_job_id', lp_job_id)
      }
    }
  } catch (err: any) {
    console.error('[upload-docs] error:', err)
    res.status(500).json({ error: err.message })
  }
}

router.post('/:lp_job_id/upload-docs', handleUploadDocs)
router.post('/:lp_job_id/upload-docs/:tabName', handleUploadDocs)

router.post('/:lp_job_id/refresh-totals', async (req, res) => {
  const { lp_job_id } = req.params

  const { data: job, error } = await supabase
    .from('jobs')
    .select('measure_sheet_url')
    .eq('lp_job_id', lp_job_id)
    .single()

  if (error || !job) return res.status(404).json({ error: 'Job not found' })
  if (!job.measure_sheet_url) return res.status(400).json({ error: 'No measure sheet' })

  const { readProjectTotals } = await import('../lib/googleSheets')
  const totals = await readProjectTotals(job.measure_sheet_url)
  if (!totals) return res.status(500).json({ error: 'Could not read sheet totals' })

  const { error: dbErr } = await supabase
    .from('jobs')
    .update(totals)
    .eq('lp_job_id', lp_job_id)

  if (dbErr) return res.status(500).json({ error: dbErr.message })

  res.json({ success: true, totals })
})

// ── Refresh all sheet data (totals + work order rows) ─────────────────────────
router.post('/:lp_job_id/refresh-sheet', async (req, res) => {
  const { lp_job_id } = req.params

  const { data: job, error } = await supabase
    .from('jobs')
    .select('measure_sheet_url')
    .eq('lp_job_id', lp_job_id)
    .single()

  if (error || !job) return res.status(404).json({ error: 'Job not found' })
  if (!job.measure_sheet_url) return res.status(400).json({ error: 'No measure sheet' })

  const { readProjectTotals, readWorkOrderRows } = await import('../lib/googleSheets')
  const [totals, workOrderRows] = await Promise.all([
    readProjectTotals(job.measure_sheet_url),
    readWorkOrderRows(job.measure_sheet_url),
  ])

  const update: any = {}
  if (totals) Object.assign(update, totals)
  if (workOrderRows) update.work_order_rows = workOrderRows

  if (Object.keys(update).length === 0) {
    return res.status(500).json({ error: 'Could not read any sheet data' })
  }

  const { error: dbErr } = await supabase
    .from('jobs')
    .update(update)
    .eq('lp_job_id', lp_job_id)

  if (dbErr) return res.status(500).json({ error: dbErr.message })

  res.json({ success: true, lp_job_id, totals, workOrderRows })
})

// ── Notes ─────────────────────────────────────────────────────────────────────

router.get('/:lp_job_id/notes', async (req, res) => {
  const { lp_job_id } = req.params
  const { data, error } = await supabase
    .from('job_notes')
    .select('*')
    .eq('lp_job_id', lp_job_id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.post('/:lp_job_id/notes', async (req, res) => {
  const { lp_job_id } = req.params
  const { note, author = 'John' } = req.body
  if (!note?.trim()) return res.status(400).json({ error: 'note is required' })

  let lpSynced = false
  try {
    await lpPost('SalesApi/AddNotes', {
      rectype: 'job',
      recid: lp_job_id,
      notes: note.trim(),
    })
    lpSynced = true
  } catch (lpErr: any) {
    console.error('[notes] LP write failed:', lpErr.message)
  }

  const { data, error } = await supabase
    .from('job_notes')
    .insert({ lp_job_id: parseInt(lp_job_id), note: note.trim(), author, lp_synced: lpSynced })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })

  res.json({ ...data, lp_synced: lpSynced })
})

// ── CompanyCam ────────────────────────────────────────────────────────────────

router.post('/backfill-companycam', async (req, res) => {
  const { resolveCompanyCamProject } = await import('../services/companyCam')
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('lp_job_id, customer_first, customer_last, address, city, state, zip, contract_date')
    .is('companycam_project_id', null)

  if (error) return res.status(500).json({ error: error.message })
  if (!jobs || !jobs.length) return res.json({ ok: true, message: 'No jobs need CC resolution', count: 0 })

  res.json({ ok: true, message: 'Backfill started for ' + jobs.length + ' jobs', count: jobs.length })

  ;(async () => {
    let resolved = 0
    for (let i = 0; i < jobs.length; i += 10) {
      const batch = jobs.slice(i, i + 10)
      const results = await Promise.allSettled(batch.map(j => resolveCompanyCamProject(j)))
      resolved += results.filter(r => r.status === 'fulfilled' && (r as any).value).length
      if (i + 10 < jobs.length) await new Promise(r => setTimeout(r, 500))
    }
    console.log('[CC backfill] Complete: ' + resolved + '/' + jobs.length)
  })()
})

router.post('/:lp_job_id/resolve-companycam', async (req, res) => {
  const { lp_job_id } = req.params
  const { resolveCompanyCamProject } = await import('../services/companyCam')

  await supabase
    .from('jobs')
    .update({ companycam_project_id: null, companycam_url: null, companycam_checked_at: null })
    .eq('lp_job_id', lp_job_id)

  const { data: job, error } = await supabase
    .from('jobs')
    .select('lp_job_id, customer_first, customer_last, address, city, state, zip, contract_date')
    .eq('lp_job_id', lp_job_id)
    .single()

  if (error || !job) return res.status(404).json({ error: 'Job not found' })

  const projectId = await resolveCompanyCamProject(job)

  const { data: updated } = await supabase
    .from('jobs')
    .select('companycam_project_id, companycam_url, companycam_checked_at')
    .eq('lp_job_id', lp_job_id)
    .single()

  res.json({ ok: true, projectId, ...updated })
})
