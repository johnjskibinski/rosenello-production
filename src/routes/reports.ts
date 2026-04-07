import { Router } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

// GET /api/reports/financial
router.get('/financial', async (req, res) => {
  try {
    const {
      date_field = 'completed_at',
      start_date,
      end_date,
      product,
      group_by = 'month',
      labor_type = 'both'
    } = req.query as Record<string, string>

    // Build jobs filter
    let jobsQuery = supabase
      .from('jobs')
      .select('lp_job_id, gross_amount, commission_amt, product, completed_at, contract_date, lp_status')
      .not('gross_amount', 'is', null)

    if (start_date) jobsQuery = jobsQuery.gte(date_field, start_date)
    if (end_date) jobsQuery = jobsQuery.lte(date_field, end_date)
    if (product) {
      const products = product.split(',')
      jobsQuery = jobsQuery.in('product', products)
    }

    const { data: jobs, error: jobsError } = await jobsQuery
    if (jobsError) return res.status(500).json({ error: jobsError.message })
    if (!jobs?.length) return res.json({ rows: [], summary: {} })

    const jobIds = jobs.map(j => j.lp_job_id)

    // Get all actual costs for these jobs
    let costsQuery = supabase
      .from('job_costs')
      .select('lp_job_id, category, is_sub, total_cost, mat_type')
      .eq('cost_type', 'actual')
      .in('lp_job_id', jobIds)

    const { data: costs, error: costsError } = await costsQuery
    if (costsError) return res.status(500).json({ error: costsError.message })

    // Build cost map per job
    const costMap: Record<number, any> = {}
    for (const c of (costs || [])) {
      if (!costMap[c.lp_job_id]) {
        costMap[c.lp_job_id] = {
          materials: 0, labor_inhouse: 0, labor_sub: 0, labor_ambiguous: 0,
          commission: 0, finance: 0, mismeasure: 0, other: 0, total: 0
        }
      }
      const m = costMap[c.lp_job_id]
      const cost = parseFloat(c.total_cost) || 0

      if (c.category === 'Materials') m.materials += cost
      else if (c.category === 'Labor') {
        if (c.is_sub === false) m.labor_inhouse += cost
        else if (c.is_sub === true) m.labor_sub += cost
        else m.labor_ambiguous += cost
      }
      else if (c.category === 'Commission') m.commission += cost
      else if (c.category === 'Finance' || c.category === 'Credit Card Fee') m.finance += cost
      else if (c.category === 'Mismeasure') m.mismeasure += cost
      else m.other += cost

      m.total += cost
    }

    // Group jobs by period
    const getPeriodKey = (dateStr: string) => {
      if (!dateStr) return 'Unknown'
      const d = new Date(dateStr)
      if (group_by === 'week') {
        const start = new Date(d)
        start.setDate(d.getDate() - d.getDay())
        return start.toISOString().split('T')[0]
      }
      if (group_by === 'month') return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
      if (group_by === 'quarter') return `${d.getFullYear()}-Q${Math.ceil((d.getMonth()+1)/3)}`
      if (group_by === 'year') return `${d.getFullYear()}`
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
    }

    const periods: Record<string, any> = {}

    for (const job of jobs) {
      const dateVal = date_field === 'contract_date' ? job.contract_date : job.completed_at
      const key = getPeriodKey(dateVal)

      if (!periods[key]) {
        periods[key] = {
          period: key,
          job_count: 0,
          gross: 0,
          materials: 0,
          labor_inhouse: 0,
          labor_sub: 0,
          labor_ambiguous: 0,
          commission: 0,
          finance: 0,
          mismeasure: 0,
          other: 0,
          total_cost: 0,
          gross_profit: 0,
          margin_pct: 0
        }
      }

      const p = periods[key]
      const costs = costMap[job.lp_job_id] || {}
      const gross = parseFloat(job.gross_amount) || 0

      // Apply labor_type filter
      let laborCost = 0
      if (labor_type === 'inhouse') laborCost = costs.labor_inhouse || 0
      else if (labor_type === 'sub') laborCost = costs.labor_sub || 0
      else laborCost = (costs.labor_inhouse || 0) + (costs.labor_sub || 0) + (costs.labor_ambiguous || 0)

      const totalCost = (costs.materials || 0) + laborCost + (costs.commission || 0) +
        (costs.finance || 0) + (costs.mismeasure || 0) + (costs.other || 0)

      p.job_count++
      p.gross += gross
      p.materials += costs.materials || 0
      p.labor_inhouse += costs.labor_inhouse || 0
      p.labor_sub += costs.labor_sub || 0
      p.labor_ambiguous += costs.labor_ambiguous || 0
      p.commission += costs.commission || 0
      p.finance += costs.finance || 0
      p.mismeasure += costs.mismeasure || 0
      p.other += costs.other || 0
      p.total_cost += totalCost
      p.gross_profit += gross - totalCost
    }

    // Calculate margins
    const rows = Object.values(periods)
      .sort((a: any, b: any) => a.period.localeCompare(b.period))
      .map((p: any) => ({
        ...p,
        gross: Math.round(p.gross * 100) / 100,
        total_cost: Math.round(p.total_cost * 100) / 100,
        gross_profit: Math.round(p.gross_profit * 100) / 100,
        margin_pct: p.gross > 0 ? Math.round((p.gross_profit / p.gross) * 1000) / 10 : 0
      }))

    // Overall summary
    const summary = rows.reduce((acc: any, r: any) => ({
      job_count: (acc.job_count || 0) + r.job_count,
      gross: (acc.gross || 0) + r.gross,
      total_cost: (acc.total_cost || 0) + r.total_cost,
      gross_profit: (acc.gross_profit || 0) + r.gross_profit,
      materials: (acc.materials || 0) + r.materials,
      labor_inhouse: (acc.labor_inhouse || 0) + r.labor_inhouse,
      labor_sub: (acc.labor_sub || 0) + r.labor_sub,
      mismeasure: (acc.mismeasure || 0) + r.mismeasure,
    }), {})

    summary.margin_pct = summary.gross > 0
      ? Math.round((summary.gross_profit / summary.gross) * 1000) / 10
      : 0

    return res.json({ rows, summary })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

// GET /api/reports/mismeasures
router.get('/mismeasures', async (req, res) => {
  try {
    const {
      start_date,
      end_date,
      product,
      status,
      error_type,
      group_by = 'month'
    } = req.query as Record<string, string>

    let query = supabase
      .from('mismeasures')
      .select(`
        id, lp_job_id, cost, error_type, unit_count, status,
        invoice_date, lp_comments, reviewed_at,
        jobs (customer_first, customer_last, product, completed_at, contract_date, installer_1, gross_amount)
      `)

    if (start_date) query = query.gte('invoice_date', start_date)
    if (end_date) query = query.lte('invoice_date', end_date)
    if (status) query = query.eq('status', status)
    if (error_type) query = query.eq('error_type', error_type)

    const { data: mismeasures, error } = await query
    if (error) return res.status(500).json({ error: error.message })

    // Filter by product if specified
    let filtered = (mismeasures || [])
    if (product) {
      const products = product.split(',')
      filtered = filtered.filter((m: any) => products.includes(m.jobs?.product))
    }

    // Summary stats
    const summary = {
      total_events: filtered.length,
      total_jobs: new Set(filtered.map((m: any) => m.lp_job_id)).size,
      total_units: filtered.reduce((s: number, m: any) => s + (m.unit_count || 1), 0),
      total_cost: filtered.reduce((s: number, m: any) => s + (parseFloat(m.cost) || 0), 0),
      pending: filtered.filter((m: any) => m.status === 'pending').length,
      by_error_type: {
        sales: filtered.filter((m: any) => m.error_type === 'sales').length,
        production: filtered.filter((m: any) => m.error_type === 'production').length,
        installer: filtered.filter((m: any) => m.error_type === 'installer').length,
        other: filtered.filter((m: any) => m.error_type === 'other').length,
        pending: filtered.filter((m: any) => m.status === 'pending').length,
      }
    }

    return res.json({ rows: filtered, summary })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

export default router
