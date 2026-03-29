import { Router } from 'express'
import { supabase } from '../lib/supabase'
import {
  pullFromGCal, pushToGCal, updateGCalEvent, deleteGCalEvent, buildNotes, eventTypeToColor
} from '../lib/googleCalendar'

const router = Router()

// GET /api/calendar - fetch all events from Supabase
router.get('/', async (_, res) => {
  const threeWeeksAgo = new Date()
  threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21)

  const { data, error } = await supabase
    .from('calendar_events')
    .select('*')
    .gte('start_time', threeWeeksAgo.toISOString())
    .order('start_time', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// POST /api/calendar/sync - pull from GCal into Supabase
router.post('/sync', async (_, res) => {
  try {
    const result = await pullFromGCal()
    res.json({ success: true, ...result })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/calendar/events - create event in Supabase + push to GCal
router.post('/events', async (req, res) => {
  const event = req.body

  // Fetch linked job if provided
  let job: any = null
  if (event.lp_job_id) {
    const { data } = await supabase.from('jobs').select('*').eq('lp_job_id', event.lp_job_id).single()
    job = data
  }

  // Build notes from job if not provided
  if (!event.notes && job) event.notes = buildNotes(job, event.event_type)

  // Push to GCal first to get gcal_event_id
  const gcalId = await pushToGCal(event, job)

  const { data, error } = await supabase
    .from('calendar_events')
    .insert({ ...event, gcal_event_id: gcalId, linked: !!job })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// PATCH /api/calendar/events/:id - update event in Supabase + GCal
router.patch('/events/:id', async (req, res) => {
  const { id } = req.params
  const updates = req.body

  const { data: existing } = await supabase
    .from('calendar_events')
    .select('*')
    .eq('id', id)
    .single()

  if (!existing) return res.status(404).json({ error: 'Event not found' })

  let job: any = null
  const jobId = updates.lp_job_id || existing.lp_job_id
  if (jobId) {
    const { data } = await supabase.from('jobs').select('*').eq('lp_job_id', jobId).single()
    job = data
  }

  const merged = { ...existing, ...updates }

  if (existing.gcal_event_id) {
    await updateGCalEvent(existing.gcal_event_id, merged, job)
  } else {
    const gcalId = await pushToGCal(merged, job)
    if (gcalId) updates.gcal_event_id = gcalId
  }

  const { data, error } = await supabase
    .from('calendar_events')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /api/calendar/events/:id - delete from Supabase, optionally from GCal
router.delete('/events/:id', async (req, res) => {
  const { id } = req.params
  const deleteFromGCal = req.query.gcal === 'true'

  const { data: existing } = await supabase
    .from('calendar_events')
    .select('gcal_event_id')
    .eq('id', id)
    .single()

  if (deleteFromGCal && existing?.gcal_event_id) {
    await deleteGCalEvent(existing.gcal_event_id)
  }

  const { error } = await supabase.from('calendar_events').delete().eq('id', id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// GET /api/calendar/unlinked - events with no job match
router.get('/unlinked', async (_, res) => {
  const { data, error } = await supabase
    .from('calendar_events')
    .select('*')
    .eq('linked', false)
    .neq('event_type', 'availability')
    .order('start_time', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

export default router
