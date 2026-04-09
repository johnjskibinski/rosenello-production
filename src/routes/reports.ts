import { Router } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

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

    let jobsQuery = supabase
      .from('jobs')
      .select('lp_job_id, gross_amount, product, completed_at, contract_date, lp_status, contract_id, customer_first, customer_last')
      .not('gross_amount', 'is', null)

    if (start_date) jobsQuery = jobsQuery.gte(date_field, start_date)
    if (end_date) jobsQuery = jobsQuery.lte(date_field, end_date)
    if (product) jobsQuery = jobsQuery.in('product', product.split(','))

    const { data: jobs, error: jobsError } = await jobsQuery
    if (jobsError) return res.status(500).json({ error: jobsError.message })
    if (!jobs?.length) return res.json({ rows: [], summary: {} })

    const jobIds = jobs.map(j => j.lp_job_id)

    const { data: costs, error: costsError } = await supabase
      .from('job_costs')
      .select('lp_job_id, category, is_sub, total_cost, mat_type')
      .eq('cost_type', 'actual')
      .in('lp_job_id', jobIds)

    if (costsError) return res.status(500).json({ error: costsError.message })

    const costMap: Record<number, any> = {}
    for (const c of (costs || [])) {
      if (!costMap[c.lp_job_id]) {
        costMap[c.lp_job_id] = {
          materials: 0, labor_inhouse: 0, labor_sub: 0, labor_ambiguous: 0,
          commission: 0, finance: 0, mismeasure: 0, other: 0
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
    }

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
          period: key, job_count: 0, gross: 0,
          materials: 0, labor_inhouse: 0, labor_sub: 0, labor_ambiguous: 0,
          commission: 0, finance: 0, mismeasure: 0, other: 0,
          total_cost: 0, gross_profit: 0, margin_pct: 0,
          job_rows: []
        }
      }

      const p = periods[key]
      const c = costMap[job.lp_job_id] || {}
      const gross = parseFloat(job.gross_amount) || 0

      let laborCost = 0
      if (labor_type === 'inhouse') laborCost = c.labor_inhouse || 0
      else if (labor_type === 'sub') laborCost = c.labor_sub || 0
      else laborCost = (c.labor_inhouse || 0) + (c.labor_sub || 0) + (c.labor_ambiguous || 0)

      const totalCost = (c.materials || 0) + laborCost + (c.commission || 0) +
        (c.finance || 0) + (c.mismeasure || 0) + (c.other || 0)
      const grossProfit = gross - totalCost
      const marginPct = gross > 0 ? Math.round((grossProfit / gross) * 1000) / 10 : 0

      p.job_count++
      p.gross += gross
      p.materials += c.materials || 0
      p.labor_inhouse += c.labor_inhouse || 0
      p.labor_sub += c.labor_sub || 0
      p.labor_ambiguous += c.labor_ambiguous || 0
      p.commission += c.commission || 0
      p.finance += c.finance || 0
      p.mismeasure += c.mismeasure || 0
      p.other += c.other || 0
      p.total_cost += totalCost
      p.gross_profit += grossProfit

      p.job_rows.push({
        lp_job_id:      job.lp_job_id,
        contract_id:    job.contract_id,
        customer:       `${job.customer_first} ${job.customer_last}`,
        product:        job.product,
        completed_at:   job.completed_at,
        gross:          Math.round(gross * 100) / 100,
        materials:      Math.round((c.materials || 0) * 100) / 100,
        labor_inhouse:  Math.round((c.labor_inhouse || 0) * 100) / 100,
        labor_sub:      Math.round((c.labor_sub || 0) * 100) / 100,
        labor_ambiguous:Math.round((c.labor_ambiguous || 0) * 100) / 100,
        commission:     Math.round((c.commission || 0) * 100) / 100,
        finance:        Math.round((c.finance || 0) * 100) / 100,
        mismeasure:     Math.round((c.mismeasure || 0) * 100) / 100,
        other:          Math.round((c.other || 0) * 100) / 100,
        total_cost:     Math.round(totalCost * 100) / 100,
        gross_profit:   Math.round(grossProfit * 100) / 100,
        margin_pct:     marginPct,
        mat_pct:        gross > 0 ? Math.round(((c.materials || 0) / gross) * 1000) / 10 : 0,
        labor_pct:      gross > 0 ? Math.round((laborCost / gross) * 1000) / 10 : 0,
        comm_pct:       gross > 0 ? Math.round(((c.commission || 0) / gross) * 1000) / 10 : 0,
      })
    }

    const rows = Object.values(periods)
      .sort((a: any, b: any) => a.period.localeCompare(b.period))
      .map((p: any) => ({
        ...p,
        gross: Math.round(p.gross * 100) / 100,
        total_cost: Math.round(p.total_cost * 100) / 100,
        gross_profit: Math.round(p.gross_profit * 100) / 100,
        margin_pct: p.gross > 0 ? Math.round((p.gross_profit / p.gross) * 1000) / 10 : 0,
        job_rows: p.job_rows.sort((a: any, b: any) =>
          (b.completed_at || '').localeCompare(a.completed_at || ''))
      }))

    const summary = rows.reduce((acc: any, r: any) => ({
      job_count:    (acc.job_count || 0) + r.job_count,
      gross:        (acc.gross || 0) + r.gross,
      total_cost:   (acc.total_cost || 0) + r.total_cost,
      gross_profit: (acc.gross_profit || 0) + r.gross_profit,
      materials:    (acc.materials || 0) + r.materials,
      labor_inhouse:(acc.labor_inhouse || 0) + r.labor_inhouse,
      labor_sub:    (acc.labor_sub || 0) + r.labor_sub,
      commission:   (acc.commission || 0) + r.commission,
      mismeasure:   (acc.mismeasure || 0) + r.mismeasure,
    }), {})

    summary.margin_pct = summary.gross > 0
      ? Math.round((summary.gross_profit / summary.gross) * 1000) / 10 : 0

    return res.json({ rows, summary })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

router.get('/mismeasure', async (req, res) => {
  try {
    const { start_date, end_date, product, status, error_type } = req.query as Record<string, string>

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

    let filtered = (mismeasures || [])
    if (product) {
      const products = product.split(',')
      filtered = filtered.filter((m: any) => products.includes(m.jobs?.product))
    }

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

router.get('/variance', async (req, res) => {
  try {
    const { start_date, end_date, product } = req.query as Record<string, string>

    let allCosts: any[] = []
    let from = 0
    const pageSize = 1000
    while (true) {
      const { data, error } = await supabase
        .from('job_costs')
        .select('lp_job_id, cost_type, total_cost')
        .range(from, from + pageSize - 1)
      if (error) return res.status(500).json({ error: error.message })
      if (!data?.length) break
      allCosts = allCosts.concat(data)
      if (data.length < pageSize) break
      from += pageSize
    }

    const costMap: Record<number, any> = {}
    for (const c of allCosts) {
      if (!costMap[c.lp_job_id]) costMap[c.lp_job_id] = { estimated: 0, actual: 0 }
      if (c.cost_type === 'estimated') costMap[c.lp_job_id].estimated += c.total_cost
      if (c.cost_type === 'actual')    costMap[c.lp_job_id].actual    += c.total_cost
    }

    const bothIds = Object.entries(costMap)
      .filter(([, c]) => c.estimated > 0 && c.actual > 0)
      .map(([id]) => parseInt(id))

    if (!bothIds.length) return res.json({ rows: [], summary: {} })

    let jobsQuery = supabase
      .from('jobs')
      .select('lp_job_id, contract_id, customer_first, customer_last, gross_amount, product, completed_at, installer_1')
      .in('lp_job_id', bothIds)
      .not('completed_at', 'is', null)

    if (start_date) jobsQuery = jobsQuery.gte('completed_at', start_date)
    if (end_date)   jobsQuery = jobsQuery.lte('completed_at', end_date)
    if (product)    jobsQuery = jobsQuery.in('product', product.split(','))

    const { data: jobs, error: jobsError } = await jobsQuery
    if (jobsError) return res.status(500).json({ error: jobsError.message })
    if (!jobs?.length) return res.json({ rows: [], summary: {} })

    const rows = jobs
      .sort((a: any, b: any) => (b.completed_at || '').localeCompare(a.completed_at || ''))
      .map((j: any) => {
        const c = costMap[j.lp_job_id]
        const variance = c.actual - c.estimated
        const variance_pct = c.estimated > 0 ? Math.round((variance / c.estimated) * 1000) / 10 : null
        return {
          lp_job_id: j.lp_job_id, contract_id: j.contract_id,
          customer: `${j.customer_first} ${j.customer_last}`,
          product: j.product, completed_at: j.completed_at,
          gross: parseFloat(j.gross_amount) || 0,
          estimated: Math.round(c.estimated * 100) / 100,
          actual: Math.round(c.actual * 100) / 100,
          variance: Math.round(variance * 100) / 100,
          variance_pct,
        }
      })

    const summary = {
      job_count:       rows.length,
      total_gross:     rows.reduce((s: number, r: any) => s + r.gross, 0),
      total_estimated: rows.reduce((s: number, r: any) => s + r.estimated, 0),
      total_actual:    rows.reduce((s: number, r: any) => s + r.actual, 0),
      total_variance:  rows.reduce((s: number, r: any) => s + r.variance, 0),
      over_budget:     rows.filter((r: any) => r.variance > 0).length,
      under_budget:    rows.filter((r: any) => r.variance < 0).length,
      on_budget:       rows.filter((r: any) => r.variance === 0).length,
    }

    return res.json({ rows, summary })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

export default router
