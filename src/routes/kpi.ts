import { Router } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

// Returns unit totals grouped by week / month / quarter / year
// based on docs_uploaded_at date (when measure was processed)
router.get('/unit-totals', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select(`
        docs_uploaded_at,
        total_windows, total_doors, bay_windows,
        bow_windows, total_openings, total_units
      `)
      .not('docs_uploaded_at', 'is', null)
      .order('docs_uploaded_at', { ascending: false })

    if (error) return res.status(500).json({ error: error.message })

    const now = new Date()

    function startOf(unit: 'week' | 'month' | 'quarter' | 'year'): Date {
      const d = new Date(now)
      if (unit === 'week') {
        const day = d.getDay()
        d.setDate(d.getDate() - day)
        d.setHours(0, 0, 0, 0)
      } else if (unit === 'month') {
        d.setDate(1); d.setHours(0, 0, 0, 0)
      } else if (unit === 'quarter') {
        const q = Math.floor(d.getMonth() / 3)
        d.setMonth(q * 3, 1); d.setHours(0, 0, 0, 0)
      } else if (unit === 'year') {
        d.setMonth(0, 1); d.setHours(0, 0, 0, 0)
      }
      return d
    }

    function sumJobs(jobs: any[]) {
      return jobs.reduce((acc, j) => ({
        total_windows:  acc.total_windows  + (j.total_windows  || 0),
        total_doors:    acc.total_doors    + (j.total_doors    || 0),
        bay_windows:    acc.bay_windows    + (j.bay_windows    || 0),
        bow_windows:    acc.bow_windows    + (j.bow_windows    || 0),
        total_openings: acc.total_openings + (j.total_openings || 0),
        total_units:    acc.total_units    + (j.total_units    || 0),
        job_count:      acc.job_count      + 1,
      }), {
        total_windows: 0, total_doors: 0, bay_windows: 0,
        bow_windows: 0, total_openings: 0, total_units: 0, job_count: 0,
      })
    }

    const periods = ['week', 'month', 'quarter', 'year'] as const
    const result: Record<string, any> = {}

    for (const period of periods) {
      const start = startOf(period)
      const filtered = (data || []).filter(j => new Date(j.docs_uploaded_at) >= start)
      result[period] = sumJobs(filtered)
    }

    // Also return the last 12 months broken out month by month for trend chart
    const monthly: Record<string, any> = {}
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now)
      d.setMonth(d.getMonth() - i, 1)
      d.setHours(0, 0, 0, 0)
      const end = new Date(d)
      end.setMonth(end.getMonth() + 1)
      const label = d.toLocaleString('default', { month: 'short', year: '2-digit' })
      const filtered = (data || []).filter(j => {
        const t = new Date(j.docs_uploaded_at)
        return t >= d && t < end
      })
      monthly[label] = sumJobs(filtered)
    }

    res.json({ periods: result, monthly })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

export default router
