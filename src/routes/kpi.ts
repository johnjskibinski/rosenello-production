import { Router } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

function getMondayOfWeek(date: Date): string {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d.toISOString().split('T')[0]
}

function getQuarterLabel(date: Date): string {
  const q = Math.floor(date.getMonth() / 3) + 1
  return `Q${q} ${date.getFullYear()}`
}

function getQuarterSortKey(label: string): string {
  const [q, y] = label.split(' ')
  return `${y}-${q.replace('Q', '')}`
}

router.get('/measure-velocity', async (_req, res) => {
  try {
    // All past measure events linked to jobs
    const { data: measures, error: mErr } = await supabase
      .from('calendar_events')
      .select('lp_job_id, start_time')
      .eq('event_type', 'measure')
      .eq('linked', true)
      .lt('start_time', new Date().toISOString())
      .order('start_time', { ascending: true })

    if (mErr) return res.status(500).json({ error: mErr.message })
    if (!measures || measures.length === 0) return res.json({ weekly: [], quarterly: [] })

    // Jobs with materials_ordered_at
    const lpIds = [...new Set(measures.map(m => m.lp_job_id))]
    const { data: jobs, error: jErr } = await supabase
      .from('jobs')
      .select('lp_job_id, materials_ordered_at')
      .in('lp_job_id', lpIds)

    if (jErr) return res.status(500).json({ error: jErr.message })

    const jobMap = new Map<number, string | null>(
      (jobs || []).map(j => [j.lp_job_id, j.materials_ordered_at])
    )

    // For rescheduled jobs, use the most recent past measure event
    const latestMeasure = new Map<number, string>()
    for (const m of measures) {
      const existing = latestMeasure.get(m.lp_job_id)
      if (!existing || m.start_time > existing) {
        latestMeasure.set(m.lp_job_id, m.start_time)
      }
    }

    const weekMap = new Map<string, { measured: number; ordered: number }>()
    const quarterMap = new Map<string, { measured: number; ordered: number }>()

    for (const [lpJobId, measureTime] of latestMeasure.entries()) {
      const measureDate = new Date(measureTime)
      const weekKey = getMondayOfWeek(measureDate)
      const quarterKey = getQuarterLabel(measureDate)

      const orderedAt = jobMap.get(lpJobId)
      const orderedWithin7 =
        orderedAt != null &&
        new Date(orderedAt).getTime() - measureDate.getTime() <= 7 * 24 * 60 * 60 * 1000

      if (!weekMap.has(weekKey)) weekMap.set(weekKey, { measured: 0, ordered: 0 })
      const w = weekMap.get(weekKey)!
      w.measured++
      if (orderedWithin7) w.ordered++

      if (!quarterMap.has(quarterKey)) quarterMap.set(quarterKey, { measured: 0, ordered: 0 })
      const q = quarterMap.get(quarterKey)!
      q.measured++
      if (orderedWithin7) q.ordered++
    }

    const weekly = Array.from(weekMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week_start, v]) => ({
        week_start,
        measured: v.measured,
        ordered_within_7: v.ordered,
        order_rate: v.measured > 0 ? Math.round((v.ordered / v.measured) * 100) : 0,
      }))

    const quarterly = Array.from(quarterMap.entries())
      .sort((a, b) => getQuarterSortKey(a[0]).localeCompare(getQuarterSortKey(b[0])))
      .map(([quarter, v]) => ({
        quarter,
        measured: v.measured,
        ordered_within_7: v.ordered,
        order_rate: v.measured > 0 ? Math.round((v.ordered / v.measured) * 100) : 0,
      }))

    res.json({ weekly, quarterly })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

export default router

router.get('/unit-totals', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('contract_date, total_windows, total_doors, bay_windows, bow_windows, total_openings, total_units')
      .not('contract_date', 'is', null)

    if (error) return res.status(500).json({ error: error.message })

    const now = new Date()

    function startOf(unit: 'week' | 'month' | 'quarter' | 'year'): Date {
      const d = new Date(now)
      if (unit === 'week') {
        const day = d.getDay()
        d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
        d.setHours(0, 0, 0, 0)
      } else if (unit === 'month') {
        d.setDate(1); d.setHours(0, 0, 0, 0)
      } else if (unit === 'quarter') {
        const q = Math.floor(d.getMonth() / 3)
        d.setMonth(q * 3, 1); d.setHours(0, 0, 0, 0)
      } else {
        d.setMonth(0, 1); d.setHours(0, 0, 0, 0)
      }
      return d
    }

    function sumMetrics(rows: any[]) {
      return {
        total_windows:  rows.reduce((s, r) => s + (r.total_windows  || 0), 0),
        total_doors:    rows.reduce((s, r) => s + (r.total_doors    || 0), 0),
        bay_windows:    rows.reduce((s, r) => s + (r.bay_windows    || 0), 0),
        bow_windows:    rows.reduce((s, r) => s + (r.bow_windows    || 0), 0),
        total_openings: rows.reduce((s, r) => s + (r.total_openings || 0), 0),
        total_units:    rows.reduce((s, r) => s + (r.total_units    || 0), 0),
        job_count: rows.length,
      }
    }

    const periods: Record<string, any> = {}
    for (const p of ['week', 'month', 'quarter', 'year'] as const) {
      const start = startOf(p)
      const rows = data.filter(r => new Date(r.contract_date) >= start)
      periods[p] = sumMetrics(rows)
    }

    // 12-month trend
    const monthly: Record<string, any> = {}
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
      const next = new Date(d.getFullYear(), d.getMonth() + 1, 1)
      const rows = data.filter(r => {
        const cd = new Date(r.contract_date)
        return cd >= d && cd < next
      })
      monthly[key] = sumMetrics(rows)
    }

    res.json({ periods, monthly })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
