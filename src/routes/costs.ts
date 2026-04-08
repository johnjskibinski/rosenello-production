import { Router } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

// POST /api/costs/import-csv
router.post('/import-csv', async (req, res) => {
  try {
    const { csv } = req.body
    if (!csv) return res.status(400).json({ error: 'csv required' })

    const lines = csv.split('\n').map((l: string) => l.trim()).filter(Boolean)
    if (lines.length < 2) return res.status(400).json({ error: 'csv has no data rows' })

    const headers = lines[0].replace(/"/g, '').split(',').map((h: string) => h.trim())
    const col = (row: string[], name: string) => {
      const i = headers.indexOf(name)
      return i >= 0 ? row[i]?.replace(/"/g, '').trim() : ''
    }

    const { data: cats } = await supabase.from('cost_categories').select('*')
    const catMap: Record<string, any> = {}
    for (const c of (cats || [])) catMap[c.mat_type] = c

    // Load all jobs into memory for fast lookup
    const { data: allJobs } = await supabase
      .from('jobs')
      .select('lp_job_id, contract_id')
    const jobByContractId: Record<string, number> = {}
    const jobByNumericPrefix: Record<string, number> = {}
    for (const j of (allJobs || [])) {
      if (j.contract_id) {
        jobByContractId[j.contract_id] = j.lp_job_id
        const prefix = j.contract_id.split('-')[0]
        if (prefix && !jobByNumericPrefix[prefix]) {
          jobByNumericPrefix[prefix] = j.lp_job_id
        }
      }
    }

    // --- PASS 1: parse all rows and resolve lp_job_ids ---
    // This lets us delete-then-reinsert cleanly, avoiding the
    // NULL invoice_date upsert collision bug in Postgres.
    const parsedRows: any[] = []
    const unknownMatTypes: string[] = []
    const seenJobIds = new Set<number>()
    const completionDates: Record<number, string> = {}

    for (let i = 1; i < lines.length; i++) {
      const row: string[] = []
      let inQuote = false
      let current = ''
      for (const ch of lines[i]) {
        if (ch === '"') { inQuote = !inQuote; continue }
        if (ch === ',' && !inQuote) { row.push(current); current = ''; continue }
        current += ch
      }
      row.push(current)

      const contractid = col(row, 'contractid') || col(row, 'GroupBy')
      const matType = col(row, 'MatType')
      const costStr = col(row, 'Cost')
      const qty = col(row, 'Qty')
      const invoiceDate = col(row, 'InvoiceDate')
      const comments = col(row, 'Comments')
      const completionDate = col(row, 'CompletionDate')

      if (!contractid || !matType) continue
      const cost = parseFloat(costStr) || 0

      let lp_job_id = jobByContractId[contractid]
      if (!lp_job_id) {
        const numericPrefix = contractid.split('-')[0]
        if (numericPrefix) lp_job_id = jobByNumericPrefix[numericPrefix]
      }
      if (!lp_job_id) continue

      const cat = catMap[matType]
      const category = cat?.category || null
      if (!cat && !unknownMatTypes.includes(matType)) unknownMatTypes.push(matType)

      seenJobIds.add(lp_job_id)

      if (completionDate) completionDates[lp_job_id] = completionDate

      parsedRows.push({
        lp_job_id,
        cost_type: 'actual',
        mat_type: matType,
        category,
        is_sub: cat?.is_sub ?? null,
        qty: parseFloat(qty) || null,
        total_cost: cost,
        labor_comment: matType === 'Labor' && comments ? comments : null,
        invoice_date: invoiceDate || null,
        comments: comments || null,
        source: 'lp_csv'
      })
    }

    // --- PASS 2: delete existing actual costs for all jobs in this CSV ---
    // This is safe because the CSV from LP is always the full cost record.
    // Fixes NULL invoice_date upsert collision (Postgres NULL != NULL in unique constraints).
    const jobIdArray = Array.from(seenJobIds)
    if (jobIdArray.length > 0) {
      const { error: deleteErr } = await supabase
        .from('job_costs')
        .delete()
        .eq('cost_type', 'actual')
        .in('lp_job_id', jobIdArray)

      if (deleteErr) {
        console.error('Delete error before reinsert:', deleteErr.message)
        return res.status(500).json({ error: deleteErr.message })
      }
    }

    // --- PASS 3: insert all rows fresh ---
    let rowsImported = 0
    let mismeasuresCreated = 0

    for (const rowData of parsedRows) {
      const { data: costRow, error: costErr } = await supabase
        .from('job_costs')
        .insert(rowData)
        .select()
        .single()

      if (costErr) {
        console.error(`Cost insert error job ${rowData.lp_job_id} ${rowData.mat_type}:`, costErr.message)
        continue
      }

      rowsImported++

      // Auto-create mismeasure record if category is Mismeasure
      if (rowData.category === 'Mismeasure' && costRow?.id) {
        const { error: mmErr } = await supabase.from('mismeasures').upsert({
          lp_job_id: rowData.lp_job_id,
          job_cost_id: costRow.id,
          cost: rowData.total_cost,
          status: 'pending',
          invoice_date: rowData.invoice_date || null,
          lp_comments: rowData.comments || null
        }, { onConflict: 'job_cost_id' })

        if (!mmErr) mismeasuresCreated++
      }
    }

    // --- PASS 4: update completed_at on jobs where CompletionDate was in CSV ---
    for (const [jobIdStr, dateStr] of Object.entries(completionDates)) {
      const d = new Date(dateStr)
      if (!isNaN(d.getTime())) {
        await supabase.from('jobs')
          .update({
            completed_at: d.toISOString().split('T')[0],
            last_cost_scraped_at: new Date().toISOString()
          })
          .eq('lp_job_id', parseInt(jobIdStr))
      }
    }

    return res.json({
      success: true,
      jobsAffected: jobIdArray.length,
      rowsImported,
      mismeasuresCreated,
      unknownMatTypes
    })
  } catch (err: any) {
    console.error('CSV import error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// POST /api/costs/:lp_job_id/estimated
router.post('/:lp_job_id/estimated', async (req, res) => {
  try {
    const lp_job_id = parseInt(req.params.lp_job_id)
    const { estimated_labor, estimated_materials } = req.body

    if (!lp_job_id) return res.status(400).json({ error: 'lp_job_id required' })

    const rows: any[] = []

    if (estimated_materials != null) {
      rows.push({
        lp_job_id,
        cost_type: 'estimated',
        mat_type: 'Materials',
        category: 'Materials',
        total_cost: parseFloat(estimated_materials),
        source: 'costing_sheet'
      })
    }

    if (estimated_labor != null) {
      rows.push({
        lp_job_id,
        cost_type: 'estimated',
        mat_type: 'Labor',
        category: 'Labor',
        total_cost: parseFloat(estimated_labor),
        source: 'costing_sheet'
      })
    }

    if (rows.length === 0) return res.status(400).json({ error: 'estimated_labor or estimated_materials required' })

    const { error } = await supabase
      .from('job_costs')
      .upsert(rows, { onConflict: 'lp_job_id,cost_type,mat_type,invoice_date' })

    if (error) return res.status(500).json({ error: error.message })

    return res.json({ success: true, rowsUpserted: rows.length })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})


// GET /api/costs/:lp_job_id
router.get('/:lp_job_id', async (req, res) => {
  const lp_job_id = parseInt(req.params.lp_job_id)
  if (!lp_job_id) return res.status(400).json({ error: 'lp_job_id required' })

  const { data, error } = await supabase
    .from('job_costs')
    .select('*')
    .eq('lp_job_id', lp_job_id)
    .order('cost_type', { ascending: true })
    .order('category', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

export default router
