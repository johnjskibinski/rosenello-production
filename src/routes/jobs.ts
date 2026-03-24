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

  // 1. Push to LP via internal djson.aspx SaveJobDetail
  try {
    const token = await getLPToken()

    const getUrl = 'https://e5d8a.leadperfection.com/djson.aspx?' + encodeURIComponent(
      JSON.stringify([{ ajax: 'GetJobDetail', options: '0', term: 'get', jobid: lp_job_id, format: 'jsondata' }])
    )
    const getRes = await fetch(getUrl, { headers: { Cookie: `LPToken=${token}` } })
    const jobData = await getRes.json()
    const j = (jobData.Records && jobData.Records[0]) ? jobData.Records[0] : (Array.isArray(jobData) ? jobData[0] : jobData)

    if (!j || !j.id) throw new Error('GetJobDetail returned no data for job ' + lp_job_id)

    const savePayload = [{
      ajax: 'SaveJobDetail',
      options: '0',
      term: 'get',
      format: 'jsondata',
      data: [{
        jobid: String(lp_job_id),
        usn: j.usn || '0',
        productid: j.productid || '',
        productid2: j.productid2 || '',
        productid3: j.productid3 || '',
        productid4: j.productid4 || '',
        vendor: j.vendor || null,
        vendor2: j.vendor2 || null,
        vendor3: j.vendor3 || null,
        vendor4: j.vendor4 || null,
        brp_id: j.brp_id || '',
        jbs_id: status,
        statusdate: new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) + ' ',
        pws_id: j.pws_id || null,
        grossamount: j.grossamount || '0.00',
        jobnetamount: j.jobnetamount || '0.00',
        contractid: j.contractid || '',
        paramount: j.paramount || '0.00',
        cmt_id: j.cmt_id || 'T',
        commission: j.commission || '0.00',
        fns_id: j.fns_id || '',
        fns_id2: j.fns_id2 || '',
        fns_id3: j.fns_id3 || '',
        fundeddate: j.fundeddate || '',
        fundedamount: j.fundedamount || '0.00',
        slr_id: j.slr_id || '0',
        slr_id2: j.slr_id2 || '0',
        slr_split: j.slr_split || '0',
        ins_installer1: j.ins_installer1 || null,
        ins_installer2: j.ins_installer2 || null,
        ins_installer3: j.ins_installer3 || null,
        ins_installer4: j.ins_installer4 || null,
        measuredby: j.measuredby || null,
        budgetcost: j.budgetcost || '0.00',
        actualcost: j.actualcost || '0.00',
        jobnotes: j.jobnotes || '',
        finco_id: j.finco_id || null,
        finamount: j.finamount || '0.00',
        finmonths: j.finmonths || '0',
        fincrlimit: j.fincrlimit || '0.00',
        finplan_id: j.finplan_id || null,
        finfee: j.finfee || '0.00',
        finapproved: j.finapproved || false,
        fin2ndlook: j.fin2ndlook || false,
        finrate: j.finrate || '0.0000',
        finterms: j.finterms || '',
        findtapproved: j.findtapproved || '',
        finexpire: j.finexpire || '',
        finhomevalue: j.finhomevalue || '0',
        finparty1name: j.finparty1name || '',
        finparty1employer: j.finparty1employer || '',
        finparty1empphone: j.finparty1empphone || '',
        finparty1income: j.finparty1income || '0',
        finparty1creditscore: j.finparty1creditscore || '0',
        finparty2name: j.finparty2name || '',
        finparty2employer: j.finparty2employer || '',
        finparty2empphone: j.finparty2empphone || '',
        finparty2income: j.finparty2income || '0',
        finparty2creditscore: j.finparty2creditscore || '0',
        finnotes: j.finnotes || '',
        batchflag: j.batchflag || false,
        batchflag2: j.batchflag2 || false,
        resource1: j.resource1 || null,
        resource2: j.resource2 || null,
        resource3: j.resource3 || null,
        resource4: j.resource4 || null,
        resource5: j.resource5 || null,
        resource6: j.resource6 || null,
        resource7: j.resource7 || null,
        resource8: j.resource8 || null,
        numextrafinrows: j.numextrafinrows || 0,
      }]
    }]

    const saveUrl = 'https://e5d8a.leadperfection.com/djson.aspx?' + encodeURIComponent(JSON.stringify(savePayload))
    const saveRes = await fetch(saveUrl, { headers: { Cookie: `LPToken=${token}` } })
    const saveData = await saveRes.json()
    console.log('[status-update] LP SaveJobDetail:', JSON.stringify(saveData).slice(0, 200))
    if (saveData.Result && saveData.Result !== 'OK') {
      throw new Error('LP SaveJobDetail failed: ' + JSON.stringify(saveData).slice(0, 200))
    }
  } catch (lpErr: any) {
    console.error(`[status-update] LP write failed for job ${lp_job_id}:`, lpErr.message)
    return res.status(502).json({
      error: 'LP write failed — Supabase was NOT updated',
      detail: lpErr.message,
    })
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
