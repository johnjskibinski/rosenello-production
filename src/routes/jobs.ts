import { Router } from 'express'
import { syncActiveJobs } from '../services/lpSync'
import { supabase } from '../lib/supabase'
import { lpPost, getLPToken } from '../lib/lpClient'

const router = Router()

router.get('/lptest', async (_, res) => {
  try {
    const token = await getLPToken()
    res.json({ token: token.slice(0, 20) + '...', length: token.length })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/lpraw', async (_, res) => {
  try {
    const today = new Date()
    const start = new Date()
    start.setDate(today.getDate() - 30)
    const fmt = (d: Date) =>
      `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`
    const data = await lpPost('Customers/GetJobStatusChanges', {
      startdate: fmt(start), enddate: fmt(today),
      cst_id: '0', job_id: '0', jbs_id: '', format: '1',
      options: '0', sortorder: '1', PageSize: '25', StartIndex: '1',
    })
    res.json(data)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/sync', async (_, res) => {
  try {
    const result = await syncActiveJobs()
    res.json({ success: true, ...result })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (!q) return res.json([])
  try {
    const term = `%${q}%`
    const { data, error } = await supabase
      .from('jobs')
      .select('id, lp_job_id, customer_first, customer_last, address, city, state, zip, lp_status, lp_status_label, product, gross_amount, balance_due, installer_1, installer_2, contract_date, total_windows, total_doors, total_units, work_order_rows, measure_sheet_url, companycam_url, raw_lp_data')
      .or(`customer_last.ilike.${term},customer_first.ilike.${term},address.ilike.${term},city.ilike.${term},contract_id.ilike.${term}`)
      .not('lp_status', 'in', '("C","P","E","X","G","J","L")')
      .order('customer_last', { ascending: true })
      .limit(25)
    if (error) throw error
    res.json(data || [])
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/jobs/push-suggestions-sheet — rebuild installer suggestions Google Sheet
router.post('/push-suggestions-sheet', async (_, res) => {
  try {
    const { pushSuggestionsToSheet } = await import('../lib/googleSheetsSuggestions')
    const result = await pushSuggestionsToSheet()
    res.json({ success: true, ...result })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/jobs/import-backlog-sheet — import suggestions from legacy Google Sheet
router.post('/import-backlog-sheet', async (_, res) => {
  try {
    const { importFromBacklogSheet } = await import('../lib/importBacklogSheet')
    const result = await importFromBacklogSheet()
    // After import, push the suggestions sheet
    import('../lib/googleSheetsSuggestions')
      .then(({ pushSuggestionsToSheet }) => pushSuggestionsToSheet())
      .catch(err => console.error('Sheet push after import failed:', err.message))
    res.json({ success: true, ...result })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/jobs/installer-suggestions — all suggestions for calendar use
router.get('/installer-suggestions', async (_, res) => {
  const { data, error } = await supabase
    .from('job_installer_suggestions')
    .select('lp_job_id, first_choice, second_choice')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

router.get('/', async (_, res) => {
  let all: any[] = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('jobs')
      .select('*')
      .order('last_synced_at', { ascending: false })
      .range(from, from + 999)
    if (error) return res.status(500).json({ error: error.message })
    if (!data?.length) break
    all = all.concat(data)
    if (data.length < 1000) break
    from += 1000
  }
  res.json(all)
})

router.patch('/:lp_job_id/status', async (req, res) => {
  const { lp_job_id } = req.params
  const { status } = req.body
  if (!status) return res.status(400).json({ error: 'status required' })
  const { data, error } = await supabase
    .from('jobs')
    .update({ lp_status: status, last_synced_at: new Date().toISOString() })
    .eq('lp_job_id', lp_job_id)
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data?.[0] ?? { lp_job_id, status, updated: false })
})

router.patch('/:lp_job_id/measure-sheet', async (req, res) => {
  const { lp_job_id } = req.params
  const { measure_sheet_url } = req.body
  if (!measure_sheet_url) return res.status(400).json({ error: 'measure_sheet_url required' })
  const isValid = measure_sheet_url.includes('docs.google.com') || measure_sheet_url.includes('drive.google.com')
  if (!isValid) return res.status(400).json({ error: 'Must be a Google Sheets or Drive URL' })
  const { data, error } = await supabase
    .from('jobs')
    .update({ measure_sheet_url })
    .eq('lp_job_id', lp_job_id)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

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
  const { note, author } = req.body
  if (!note?.trim()) return res.status(400).json({ error: 'note required' })
  const { data, error } = await supabase
    .from('job_notes')
    .insert({ lp_job_id: parseInt(lp_job_id), note: note.trim(), author: author || 'John' })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  try {
    const { lpPost } = await import('../lib/lpClient')
    await lpPost('SalesApi/AddNotes', { rectype: 'job', recid: lp_job_id, notes: note.trim() })
    await supabase.from('job_notes').update({ lp_synced: true }).eq('id', data.id)
    data.lp_synced = true
  } catch { }
  res.json(data)
})

// GET /api/jobs/:lp_job_id/installer-suggestion
router.get('/:lp_job_id/installer-suggestion', async (req, res) => {
  const { lp_job_id } = req.params
  const { data, error } = await supabase
    .from('job_installer_suggestions')
    .select('*')
    .eq('lp_job_id', lp_job_id)
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || null)
})

// PUT /api/jobs/:lp_job_id/installer-suggestion — upsert
router.put('/:lp_job_id/installer-suggestion', async (req, res) => {
  const { lp_job_id } = req.params
  const { first_choice, second_choice, notes } = req.body
  const { data, error } = await supabase
    .from('job_installer_suggestions')
    .upsert(
      {
        lp_job_id: parseInt(lp_job_id),
        first_choice: first_choice || null,
        second_choice: second_choice || null,
        notes: notes || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'lp_job_id' }
    )
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  // Push to sheet in background — fire and forget
  import('../lib/googleSheetsSuggestions')
    .then(({ pushSuggestionsToSheet }) => pushSuggestionsToSheet())
    .catch(err => console.error('Sheet push failed:', err.message))
  res.json(data)
})

router.post('/:lp_job_id/upload-docs', async (req, res) => {
  const { lp_job_id } = req.params
  try {
    const { uploadJobDocs } = await import('../services/lpUpload')
    const result = await uploadJobDocs(parseInt(lp_job_id))
    res.json(result)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/:lp_job_id/upload-docs/:tabName', async (req, res) => {
  const { lp_job_id, tabName } = req.params
  try {
    const { uploadJobDocs } = await import('../services/lpUpload')
    const result = await uploadJobDocs(parseInt(lp_job_id), tabName)
    res.json(result)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})


// POST /api/jobs/backfill-completed-dates
// Accepts the LP summary CSV, updates completed_at for each job using lp_job_id
router.post('/backfill-completed-dates', async (req, res) => {
  try {
    const { csv } = req.body
    if (!csv) return res.status(400).json({ error: 'csv required' })

    const lines = csv.split('\n').map((l: string) => l.trim()).filter(Boolean)
    if (lines.length < 2) return res.status(400).json({ error: 'no data rows' })

    // Parse headers — strip quotes
    const headers = lines[0].replace(/"/g, '').split(',').map((h: string) => h.trim())
    const idx = (name: string) => headers.indexOf(name)
    const contractIdx    = idx('contractid')
    const completionIdx  = idx('CompletionDate')

    if (contractIdx === -1 || completionIdx === -1) {
      return res.status(400).json({ error: `Missing columns. Found: ${headers.join(', ')}` })
    }

    // Build contract_id -> completion_date map (one per contract, take first seen)
    const contractDates: Record<string, string> = {}
    for (let i = 1; i < lines.length; i++) {
      const row: string[] = []
      let inQuote = false
      let current = ''
      for (const ch of lines[i]) {
        if (ch === '"') { inQuote = !inQuote; continue }
        if (ch === ',' && !inQuote) { row.push(current.trim()); current = ''; continue }
        current += ch
      }
      row.push(current.trim())

      const contractId     = row[contractIdx]?.trim()
      const completionDate = row[completionIdx]?.trim()
      if (!contractId || !completionDate || contractDates[contractId]) continue
      const d = new Date(completionDate)
      if (!isNaN(d.getTime())) contractDates[contractId] = d.toISOString().split('T')[0]
    }

    let updated = 0
    let skipped = 0

    for (const [contractId, completed_at] of Object.entries(contractDates)) {
      const { error } = await supabase
        .from('jobs')
        .update({ completed_at })
        .eq('contract_id', contractId)

      if (error) { skipped++; continue }
      updated++
    }

    return res.json({ success: true, updated, skipped, contractsProcessed: Object.keys(contractDates).length })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

// POST /api/jobs/backfill-dates-from-summary
// Uses LP summary CSV (job_id + CompleteDate) to populate completed_at
router.post('/backfill-dates-from-summary', async (req, res) => {
  try {
    const { csv } = req.body
    if (!csv) return res.status(400).json({ error: 'csv required' })

    const lines = csv.split('\n').map((l: string) => l.trim()).filter(Boolean)
    if (lines.length < 2) return res.status(400).json({ error: 'no data rows' })

    const headers = lines[0].replace(/"/g, '').split(',').map((h: string) => h.trim())
    const jobIdIdx   = headers.indexOf('job_id')
    const dateIdx    = headers.indexOf('CompleteDate')

    if (jobIdIdx === -1 || dateIdx === -1) {
      return res.status(400).json({ error: `Missing columns. Need job_id and CompleteDate. Found: ${headers.join(', ')}` })
    }

    let updated = 0
    let skipped = 0

    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',').map((v: string) => v.replace(/"/g, '').trim())
      const lp_job_id = parseInt(row[jobIdIdx])
      const dateRaw   = row[dateIdx]

      if (!lp_job_id || !dateRaw) { skipped++; continue }
      const d = new Date(dateRaw)
      if (isNaN(d.getTime())) { skipped++; continue }

      const completed_at = d.toISOString().split('T')[0]
      const { error } = await supabase
        .from('jobs')
        .update({ completed_at })
        .eq('lp_job_id', lp_job_id)

      if (error) { skipped++; continue }
      updated++
    }

    return res.json({ success: true, updated, skipped })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})


// POST /api/jobs/bulk-set-completed-dates
// Accepts array of {lp_job_id, completed_at} and updates each job
router.post('/bulk-set-completed-dates', async (req, res) => {
  try {
    const { updates } = req.body
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'updates array required' })
    }

    let updated = 0
    let skipped = 0

    for (const u of updates) {
      const { lp_job_id, completed_at } = u
      if (!lp_job_id || !completed_at) { skipped++; continue }

      const { error } = await supabase
        .from('jobs')
        .update({ completed_at })
        .eq('lp_job_id', lp_job_id)

      if (error) { skipped++; continue }
      updated++
    }

    return res.json({ success: true, updated, skipped })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})


export default router
