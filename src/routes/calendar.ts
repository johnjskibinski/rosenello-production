import { Router } from 'express'
import { supabase } from '../lib/supabase'
import {
  pullFromGCal, pushToGCal, updateGCalEvent, deleteGCalEvent, buildNotes
} from '../lib/googleCalendar'

const router = Router()

// GET /api/calendar — fetch events with optional date range
router.get('/', async (req, res) => {
  const { start, end } = req.query
  const threeWeeksAgo = new Date()
  threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21)

  let query = supabase
    .from('calendar_events')
    .select('*')
    .gte('start_time', start ? String(start) : threeWeeksAgo.toISOString())
    .order('start_time', { ascending: true })

  if (end) query = query.lte('start_time', String(end))

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// POST /api/calendar/sync — pull from GCal into Supabase
router.post('/sync', async (_, res) => {
  try {
    const result = await pullFromGCal()
    res.json({ success: true, ...result })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/calendar/events — create event in Supabase + push to GCal
router.post('/events', async (req, res) => {
  const event = req.body

  let job: any = null
  if (event.lp_job_id) {
    const { data } = await supabase.from('jobs').select('*').eq('lp_job_id', event.lp_job_id).single()
    job = data
  }

  if (!event.notes && job) event.notes = buildNotes(job, event.event_type)

  const gcalId = await pushToGCal(event, job)

  const { data, error } = await supabase
    .from('calendar_events')
    .insert({ ...event, gcal_event_id: gcalId, linked: !!job })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// PATCH /api/calendar/events/:id — update in Supabase + GCal
router.patch('/events/:id', async (req, res) => {
  const { id } = req.params
  const updates = req.body

  const { data: existing } = await supabase
    .from('calendar_events').select('*').eq('id', id).single()
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
    .eq('id', id).select().single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /api/calendar/events/:id — delete from Supabase + optionally GCal
router.delete('/events/:id', async (req, res) => {
  const { id } = req.params
  const deleteFromGCal = req.query.gcal === 'true'

  const { data: existing } = await supabase
    .from('calendar_events').select('gcal_event_id').eq('id', id).single()

  if (deleteFromGCal && existing?.gcal_event_id) {
    await deleteGCalEvent(existing.gcal_event_id)
  }

  const { error } = await supabase.from('calendar_events').delete().eq('id', id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// GET /api/calendar/unlinked — events with no job match
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

// GET /api/calendar/availability — fetch crew availability notes
router.get('/availability', async (req, res) => {
  const { start, end } = req.query
  let query = supabase.from('calendar_availability').select('*')
  if (start) query = query.gte('date', String(start).slice(0, 10))
  if (end) query = query.lte('date', String(end).slice(0, 10))
  const { data, error } = await query.order('date')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// POST /api/calendar/availability — save crew availability note
router.post('/availability', async (req, res) => {
  const { date, notes } = req.body
  if (!date) return res.status(400).json({ error: 'date required' })

  if (!notes || !notes.trim()) {
    await supabase.from('calendar_availability').delete().eq('date', date)
    return res.json({ deleted: true })
  }

  const { data, error } = await supabase
    .from('calendar_availability')
    .upsert({ date, notes: notes.trim(), updated_at: new Date().toISOString() }, { onConflict: 'date' })
    .select().single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// GET /api/calendar/installers — list all active installers
router.get('/installers', async (_, res) => {
  const { data, error } = await supabase
    .from('installers')
    .select('*')
    .eq('active', true)
    .order('sort_order')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// POST /api/calendar/installers — add installer
router.post('/installers', async (req, res) => {
  const { name, initials } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  const { data, error } = await supabase
    .from('installers').insert({ name, initials: initials || '' }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /api/calendar/installers/:id — deactivate installer
router.delete('/installers/:id', async (req, res) => {
  const { id } = req.params
  const { error } = await supabase
    .from('installers').update({ active: false }).eq('id', id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

export default router
