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

// Search endpoint — searches all active jobs across all statuses
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

router.get('/', async (_, res) => {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .order('last_synced_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
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

export default router

router.patch('/:lp_job_id/measure-sheet', async (req, res) => {
  const { lp_job_id } = req.params
  const { measure_sheet_url } = req.body
  if (!measure_sheet_url) return res.status(400).json({ error: 'measure_sheet_url required' })

  // Validate it's a Google Sheets/Drive URL
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

// GET /api/jobs/:lp_job_id/notes
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

// POST /api/jobs/:lp_job_id/notes
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

  // Try to sync to LP
  try {
    const { lpPost } = await import('../lib/lpClient')
    await lpPost('Customers/AddNotes', {
      job_id: lp_job_id,
      note: note.trim(),
      author: author || 'John',
    })
    await supabase.from('job_notes').update({ lp_synced: true }).eq('id', data.id)
    data.lp_synced = true
  } catch {
    // LP sync failed — note still saved locally
  }

  res.json(data)
})

// POST /api/jobs/:lp_job_id/upload-docs
// POST /api/jobs/:lp_job_id/upload-docs/:tabName
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
