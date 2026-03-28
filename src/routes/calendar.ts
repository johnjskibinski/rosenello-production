import { Router } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

// GET /api/calendar/events?start=&end=
router.get('/events', async (req, res) => {
  const { start, end } = req.query

  let query = supabase
    .from('calendar_events')
    .select('*, jobs(customer_first, customer_last, address, city, state, zip, measure_sheet_url, companycam_url, work_order_rows, raw_lp_data)')
    .order('start_time', { ascending: true })

  if (start) query = query.gte('start_time', String(start))
  if (end) query = query.lte('start_time', String(end))

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// POST /api/calendar/events
router.post('/events', async (req, res) => {
  const {
    lp_job_id,
    event_type,
    crew,
    title,
    description,
    location,
    start_time,
    end_time,
    color_id,
    notes,
  } = req.body

  if (!event_type || !start_time || !end_time) {
    return res.status(400).json({ error: 'event_type, start_time, end_time required' })
  }

  let autoTitle = title
  let autoDescription = description
  let autoLocation = location
  let companycam_url = null
  let measure_sheet_url = null

  if (lp_job_id) {
    const { data: job } = await supabase
      .from('jobs')
      .select('customer_first, customer_last, address, city, state, zip, measure_sheet_url, companycam_url, work_order_rows, raw_lp_data')
      .eq('lp_job_id', lp_job_id)
      .single()

    if (job) {
      if (!autoTitle) {
        const lastName = job.customer_last || ''
        const firstName = job.customer_first || ''
        const customerPart = `${lastName}, ${firstName}`.trim().replace(/^,\s*/, '')
        const crewPrefix = crew && event_type === 'install' ? `(${crew}) ` : ''
        autoTitle = `${crewPrefix}${customerPart}`
      }

      if (!autoLocation) {
        autoLocation = [job.address, job.city, job.state, job.zip].filter(Boolean).join(', ')
      }

      companycam_url = job.companycam_url
      measure_sheet_url = job.measure_sheet_url

      if (!autoDescription) {
        const d = job.raw_lp_data || {}
        const phone = d.phone1 || d.phone2 || ''
        const typeLabel = event_type === 'measure' ? 'Measure'
          : event_type === 'install' ? 'Install'
          : event_type === 'service' ? 'Service'
          : 'Reminder'

        const workOrderLines = Array.isArray(job.work_order_rows)
          ? job.work_order_rows
              .map((row: any[]) => Array.isArray(row) ? String(row[0] || '').trim() : String(row || '').trim())
              .filter(Boolean)
              .join('\n')
          : ''

        const parts = [phone, typeLabel, workOrderLines, notes || ''].filter(Boolean)
        autoDescription = parts.join('\n\n')
      }
    }
  }

  const colorMap: Record<string, string> = {
    measure: '5', install: '6', service: '7', reminder: '8',
  }

  const { data, error } = await supabase
    .from('calendar_events')
    .insert({
      lp_job_id: lp_job_id || null,
      event_type,
      crew: crew || null,
      title: autoTitle || '',
      description: autoDescription || '',
      location: autoLocation || '',
      start_time,
      end_time,
      color_id: color_id || colorMap[event_type] || '8',
      companycam_url,
      measure_sheet_url,
      notes: notes || null,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// PATCH /api/calendar/events/:id
router.patch('/events/:id', async (req, res) => {
  const { id } = req.params
  const updates = req.body

  const { data, error } = await supabase
    .from('calendar_events')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /api/calendar/events/:id
router.delete('/events/:id', async (req, res) => {
  const { id } = req.params

  const { error } = await supabase
    .from('calendar_events')
    .delete()
    .eq('id', id)

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// GET /api/calendar/availability?start=&end=
router.get('/availability', async (req, res) => {
  const { start, end } = req.query
  if (!start || !end) return res.status(400).json({ error: 'start and end required' })

  const { data, error } = await supabase
    .from('crew_availability')
    .select('id, date, notes')
    .gte('date', String(start).slice(0, 10))
    .lte('date', String(end).slice(0, 10))
    .order('date', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// POST /api/calendar/availability  (upsert by date)
router.post('/availability', async (req, res) => {
  const { date, notes } = req.body
  if (!date) return res.status(400).json({ error: 'date required' })

  if (!notes || !notes.trim()) {
    // If notes is empty, delete the record for that date
    const { error } = await supabase
      .from('crew_availability')
      .delete()
      .eq('date', date)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ deleted: true, date })
  }

  const { data, error } = await supabase
    .from('crew_availability')
    .upsert({ date, notes: notes.trim(), updated_at: new Date().toISOString() }, { onConflict: 'date' })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

export default router
