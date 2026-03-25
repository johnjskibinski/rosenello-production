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

  // Pull job data to auto-fill description if lp_job_id provided
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
      // Auto-build title if not provided
      if (!autoTitle) {
        const lastName = job.customer_last || ''
        const firstName = job.customer_first || ''
        const customerPart = `${lastName}, ${firstName}`.trim().replace(/^,\s*/, '')
        const crewPrefix = crew && event_type === 'install' ? `(${crew}) ` : ''
        autoTitle = `${crewPrefix}${customerPart}`
      }

      // Auto-build location
      if (!autoLocation) {
        autoLocation = [job.address, job.city, job.state, job.zip].filter(Boolean).join(', ')
      }

      // Auto-build description
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
              .map((row: any[]) => row.filter(Boolean).join(' ').trim())
              .filter(Boolean)
              .join('\n')
          : ''

        const parts = [
          phone,
          typeLabel,
          workOrderLines,
          notes || '',
        ].filter(Boolean)

        if (measure_sheet_url && (event_type === 'measure' || event_type === 'install')) {
          parts.push(`📋 Measure Packet:\n<${measure_sheet_url}>`)
        }
        if (companycam_url && (event_type === 'measure' || event_type === 'install')) {
          parts.push(`📸 CompanyCam:\n<${companycam_url}>`)
        }

        autoDescription = parts.join('\n\n')
      }
    }
  }

  const colorMap: Record<string, string> = {
    measure: '5',
    install: '6',
    service: '7',
    reminder: '8',
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

export default router
