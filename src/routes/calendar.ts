import { Router } from 'express'
import { supabase } from '../lib/supabase'
import {
  pullFromGCal, pushToGCal, updateGCalEvent, deleteGCalEvent, buildNotes
} from '../lib/googleCalendar'

const router = Router()

router.get('/', async (req, res) => {
  const { start, end } = req.query
  const threeWeeksAgo = new Date()
  threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21)
  let query = supabase.from('calendar_events').select('*')
    .gte('start_time', start ? String(start) : threeWeeksAgo.toISOString())
    .order('start_time', { ascending: true })
  if (end) query = query.lte('start_time', String(end))
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.post('/sync', async (_, res) => {
  try {
    const result = await pullFromGCal()
    res.json({ success: true, ...result })
  } catch (err: any) {
    console.error("SYNC ERROR FULL:", JSON.stringify(err, null, 2))
    res.status(500).json({ error: err.message, code: err.code })
  }
})

router.post('/events', async (req, res) => {
  const event = req.body
  let job: any = null
  if (event.lp_job_id) {
    const { data } = await supabase.from('jobs').select('*').eq('lp_job_id', event.lp_job_id).single()
    job = data
  }
  if (!event.notes && job) event.notes = buildNotes(job, event.event_type)
  const gcalId = await pushToGCal(event, job)
  const { data, error } = await supabase.from('calendar_events')
    .insert({ ...event, gcal_event_id: gcalId, linked: !!job }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.patch('/events/:id', async (req, res) => {
  const { id } = req.params
  const updates = req.body
  const { data: existing } = await supabase.from('calendar_events').select('*').eq('id', id).single()
  if (!existing) return res.status(404).json({ error: 'Event not found' })
  let job: any = null
  const jobId = updates.lp_job_id || existing.lp_job_id
  if (jobId) {
    const { data } = await supabase.from('jobs').select('*').eq('lp_job_id', jobId).single()
    job = data
  }
  const merged = { ...existing, ...updates }
  if (merged.installers?.length > 0 && !merged.installer) merged.installer = merged.installers[0]
  if (existing.gcal_event_id) {
    await updateGCalEvent(existing.gcal_event_id, merged, job)
  } else {
    const gcalId = await pushToGCal(merged, job)
    if (gcalId) updates.gcal_event_id = gcalId
  }
  const { data, error } = await supabase.from('calendar_events')
    .update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.delete('/events/:id', async (req, res) => {
  const { id } = req.params
  const deleteFromGCal = req.query.gcal === 'true'
  const { data: existing } = await supabase.from('calendar_events').select('gcal_event_id').eq('id', id).single()
  if (deleteFromGCal && existing?.gcal_event_id) await deleteGCalEvent(existing.gcal_event_id)
  const { error } = await supabase.from('calendar_events').delete().eq('id', id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

router.get('/unlinked', async (_, res) => {
  const { data, error } = await supabase.from('calendar_events').select('*')
    .eq('linked', false).neq('event_type', 'availability').order('start_time', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.get('/availability', async (req, res) => {
  const { start, end } = req.query
  let query = supabase.from('calendar_availability').select('*')
  if (start) query = query.gte('date', String(start).slice(0, 10))
  if (end) query = query.lte('date', String(end).slice(0, 10))
  const { data, error } = await query.order('date')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

router.post('/availability', async (req, res) => {
  const { date, notes, gcal_event_ids } = req.body
  if (!date) return res.status(400).json({ error: 'date required' })
  if (!notes || !notes.trim()) {
    if (Array.isArray(gcal_event_ids)) {
      for (const id of gcal_event_ids) { try { await deleteGCalEvent(id) } catch {} }
    }
    await supabase.from('calendar_availability').delete().eq('date', date)
    return res.json({ deleted: true })
  }
  const lines = notes.trim().split('\n').map((l: string) => l.trim()).filter(Boolean)
  const newGcalIds: string[] = []
  if (Array.isArray(gcal_event_ids)) {
    for (const id of gcal_event_ids) { try { await deleteGCalEvent(id) } catch {} }
  }
  for (const line of lines) {
    const gcalId = await pushToGCal({ title: line, event_type: 'availability', all_day: true, start_time: date, end_time: date, notes: null, location: '' }, null)
    if (gcalId) newGcalIds.push(gcalId)
  }
  const { data, error } = await supabase.from('calendar_availability')
    .upsert({ date, notes: notes.trim(), gcal_event_ids: newGcalIds, updated_at: new Date().toISOString() }, { onConflict: 'date' })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.get('/installers', async (_, res) => {
  const { data, error } = await supabase.from('installers').select('*').eq('active', true).order('sort_order')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.post('/installers', async (req, res) => {
  const { name, initials } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  const { data, error } = await supabase.from('installers').insert({ name, initials: initials || '' }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// PATCH /api/calendar/installers/:id — rename + cascade to suggestions + push sheet
router.patch('/installers/:id', async (req, res) => {
  const { id } = req.params
  const { name, initials } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'name required' })

  const { data: existing, error: fetchErr } = await supabase
    .from('installers').select('name, initials').eq('id', id).single()
  if (fetchErr || !existing) return res.status(404).json({ error: 'Installer not found' })

  const oldName = existing.name
  const newName = name.trim()

  const { data, error } = await supabase.from('installers')
    .update({ name: newName, initials: initials?.trim() || existing.initials })
    .eq('id', id).select().single()
  if (error) return res.status(500).json({ error: error.message })

  if (oldName !== newName) {
    await supabase.from('job_installer_suggestions')
      .update({ first_choice: newName, updated_at: new Date().toISOString() })
      .eq('first_choice', oldName)
    await supabase.from('job_installer_suggestions')
      .update({ second_choice: newName, updated_at: new Date().toISOString() })
      .eq('second_choice', oldName)
    import('../lib/googleSheetsSuggestions')
      .then(({ pushSuggestionsToSheet }) => pushSuggestionsToSheet())
      .catch(err => console.error('Sheet push after rename failed:', err.message))
  }

  res.json({ success: true, installer: data, oldName, newName, cascaded: oldName !== newName })
})

// DELETE /api/calendar/installers/:id — check affected jobs, deactivate if force=true
router.delete('/installers/:id', async (req, res) => {
  const { id } = req.params
  const force = req.query.force === 'true'

  const { data: installer, error: fetchErr } = await supabase
    .from('installers').select('name').eq('id', id).single()
  if (fetchErr || !installer) return res.status(404).json({ error: 'Installer not found' })

  const name = installer.name

  const { data: affected } = await supabase
    .from('job_installer_suggestions')
    .select('lp_job_id, first_choice, second_choice')
    .or(`first_choice.eq.${name},second_choice.eq.${name}`)

  if ((affected?.length ?? 0) > 0 && !force) {
    const lpJobIds = (affected || []).map(a => a.lp_job_id)
    const { data: jobs } = await supabase.from('jobs')
      .select('lp_job_id, customer_first, customer_last').in('lp_job_id', lpJobIds)
    return res.status(409).json({
      conflict: true,
      installerName: name,
      affectedCount: affected!.length,
      affectedJobs: (jobs || []).map(j => ({
        lp_job_id: j.lp_job_id,
        name: `${j.customer_last}, ${j.customer_first}`,
      })),
    })
  }

  const { error } = await supabase.from('installers').update({ active: false }).eq('id', id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

export default router
