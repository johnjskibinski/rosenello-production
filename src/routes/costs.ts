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

    let rowsImported = 0
    let mismeasuresCreated = 0
    const unknownMatTypes: string[] = []

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

      const { data: jobRow } = await supabase
        .from('jobs')
        .select('lp_job_id')
        .eq('contract_id', contractid)
        .single()

      if (!jobRow) continue
      const lp_job_id = jobRow.lp_job_id

      const cat = catMap[matType]
      const category = cat?.category || null
      if (!cat && !unknownMatTypes.includes(matType)) unknownMatTypes.push(matType)

      const laborComment = matType === 'Labor' && comments ? comments : null

      const { data: costRow, error: costErr } = await supabase
        .from('job_costs')
        .upsert({
          lp_job_id,
          cost_type: 'actual',
          mat_type: matType,
          category,
          is_sub: cat?.is_sub ?? null,
          qty: parseFloat(qty) || null,
          total_cost: cost,
          labor_comment: laborComment,
          invoice_date: invoiceDate || null,
          comments: comments || null,
          source: 'lp_csv'
        }, { onConflict: 'lp_job_id,cost_type,mat_type,invoice_date' })
        .select()
        .single()

      if (costErr) {
        console.error(`Cost upsert error job ${lp_job_id} ${matType}:`, costErr.message)
        continue
      }

      rowsImported++

      if (completionDate) {
        const d = new Date(completionDate)
        if (!isNaN(d.getTime())) {
          await supabase.from('jobs')
            .update({
              completed_at: d.toISOString().split('T')[0],
              last_cost_scraped_at: new Date().toISOString()
            })
            .eq('lp_job_id', lp_job_id)
        }
      }

      if (category === 'Mismeasure' && costRow) {
        const { error: mmErr } = await supabase.from('mismeasures').upsert({
          lp_job_id,
          job_cost_id: costRow.id,
          cost,
          status: 'pending',
          invoice_date: invoiceDate || null,
          lp_comments: comments || null
        }, { onConflict: 'job_cost_id' })

        if (!mmErr) mismeasuresCreated++
      }
    }

    return res.json({
      success: true,
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

