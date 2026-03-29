import { google } from 'googleapis'
import { supabase } from './supabase'

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID!

function getCalendarClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  )
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return google.calendar({ version: 'v3', auth })
}

// Color ID → event type
export function colorToEventType(colorId: string | null | undefined): 'measure' | 'install' | 'availability' {
  if (colorId === '5') return 'measure'       // Banana/Yellow
  if (colorId === '6') return 'install'       // Tangerine
  if (colorId === '11') return 'availability' // Tomato
  return 'install'                            // Default/no color = install
}

// Event type → color ID
export function eventTypeToColor(type: string): string {
  if (type === 'measure') return '5'
  if (type === 'availability') return '11'
  return '6' // install = tangerine (works on both test + prod)
}

// Normalize title from GCal to standard format given a matched job
export function normalizeTitle(rawTitle: string, job: any): string {
  if (!job) return rawTitle
  const last = job.customer_last || ''
  const first = job.customer_first || ''
  const installer = job.installer_1 || ''
  const prefix = installer ? `(${installer}) ` : ''
  return `${prefix}${last}, ${first}`.trim()
}

// Extract installer from title like "(Jay W) Smith, John"
export function extractInstaller(title: string): string {
  const match = title.match(/^\(([^)]+)\)/)
  return match ? match[1] : ''
}

// Extract last name from title like "(Jay W) Smith, John" or "Smith, John" or "Smith"
export function extractLastName(title: string): string {
  const stripped = title.replace(/^\([^)]+\)\s*/, '').trim()
  return stripped.split(',')[0].trim()
}

// Build notes string for a job event
export function buildNotes(job: any, eventType: string): string {
  const lines: string[] = []
  if (job.raw_lp_data?.phone1) lines.push(`Phone: ${job.raw_lp_data.phone1}`)

  // Work order lines from raw LP data
  const wo = job.raw_lp_data?.workorderlines || job.raw_lp_data?.work_order_lines
  if (Array.isArray(wo) && wo.length > 0) {
    wo.forEach((l: any) => { if (l.description) lines.push(l.description) })
  } else if (job.raw_lp_data?.workorder) {
    lines.push(job.raw_lp_data.workorder)
  }

  // CompanyCam
  if (job.companycam_url) lines.push(`📷 CompanyCam:\n<${job.companycam_url}>`)

  // Measure sheet — measures only
  if (eventType === 'measure' && job.measure_sheet_url) {
    lines.push(`📋 Measure Packet:\n<${job.measure_sheet_url}>`)
  }

  return lines.join('\n')
}

// Try to match a GCal event to a job in Supabase
export async function matchEventToJob(gcalEvent: any): Promise<any | null> {
  const location = gcalEvent.location || ''
  const title = gcalEvent.summary || ''

  // 1. Try address match — extract street number + name from location
  if (location) {
    const streetMatch = location.match(/^(\d+\s+[^,]+)/i)
    if (streetMatch) {
      const street = streetMatch[1].trim().toLowerCase()
      const { data } = await supabase
        .from('jobs')
        .select('*')
        .ilike('address', `%${street}%`)
        .limit(1)
      if (data && data.length > 0) return data[0]
    }
  }

  // 2. Fallback: last name match
  const lastName = extractLastName(title)
  if (lastName && lastName.length > 2) {
    const { data } = await supabase
      .from('jobs')
      .select('*')
      .ilike('customer_last', lastName)
      .limit(1)
    if (data && data.length > 0) return data[0]
  }

  return null
}

// Pull events from GCal, upsert into Supabase
export async function pullFromGCal(): Promise<{ synced: number; unlinked: number }> {
  const cal = getCalendarClient()
  const threeWeeksAgo = new Date()
  threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21)

  let synced = 0
  let unlinked = 0
  let pageToken: string | undefined

  do {
    const res = await cal.events.list({
      calendarId: CALENDAR_ID,
      timeMin: threeWeeksAgo.toISOString(),
      maxResults: 250,
      singleEvents: true,
      orderBy: 'startTime',
      pageToken,
    })

    const events = res.data.items || []
    pageToken = res.data.nextPageToken || undefined

    for (const ev of events) {
      if (!ev.id || ev.status === 'cancelled') continue

      const colorId = (ev as any).colorId || null
      const eventType = colorToEventType(colorId)
      const allDay = !ev.start?.dateTime
      const startTime = ev.start?.dateTime || ev.start?.date
      const endTime = ev.end?.dateTime || ev.end?.date
      if (!startTime || !endTime) continue

      let job: any = null
      let linked = false

      // Skip availability matching
      if (eventType === 'availability') {
        // Write all-day availability events to calendar_availability table
        if (allDay) {
          const date = startTime.slice(0, 10)
          const notes = ev.summary || ''
          await supabase.from('calendar_availability')
            .upsert({ date, notes, updated_at: new Date().toISOString() }, { onConflict: 'date' })
        }
        continue
      }

      job = await matchEventToJob(ev)
      linked = !!job
      if (!linked) unlinked++

      const title = job ? normalizeTitle(ev.summary || '', job) : (ev.summary || '')
      const installer = extractInstaller(ev.summary || '')

      const row = {
        gcal_event_id: ev.id,
        lp_job_id: job?.lp_job_id || null,
        event_type: eventType,
        title,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        all_day: allDay,
        location: ev.location || '',
        notes: ev.description || '',
        installer,
        color_id: colorId,
        linked,
        raw_gcal_data: ev,
        updated_at: new Date().toISOString(),
      }

      await supabase.from('calendar_events').upsert(row, { onConflict: 'gcal_event_id' })
      synced++
    }
  } while (pageToken)

  return { synced, unlinked }
}

// Push a Supabase calendar event to GCal, return gcal_event_id
export async function pushToGCal(event: any, job: any): Promise<string | null> {
  const cal = getCalendarClient()

  const gcalEvent: any = {
    summary: event.title,
    location: event.location || '',
    description: event.notes || (job ? buildNotes(job, event.event_type) : ''),
    colorId: eventTypeToColor(event.event_type),
    start: event.all_day
      ? { date: event.start_time.slice(0, 10) }
      : { dateTime: event.start_time, timeZone: 'America/New_York' },
    end: event.all_day
      ? { date: event.end_time.slice(0, 10) }
      : { dateTime: event.end_time, timeZone: 'America/New_York' },
  }

  try {
    const res = await cal.events.insert({ calendarId: CALENDAR_ID, requestBody: gcalEvent })
    return res.data.id || null
  } catch (err) {
    console.error('GCal push error:', err)
    return null
  }
}

// Update an existing GCal event
export async function updateGCalEvent(gcalEventId: string, event: any, job: any): Promise<void> {
  const cal = getCalendarClient()

  const gcalEvent: any = {
    summary: event.title,
    location: event.location || '',
    description: event.notes || (job ? buildNotes(job, event.event_type) : ''),
    colorId: eventTypeToColor(event.event_type),
    start: event.all_day
      ? { date: event.start_time.slice(0, 10) }
      : { dateTime: event.start_time, timeZone: 'America/New_York' },
    end: event.all_day
      ? { date: event.end_time.slice(0, 10) }
      : { dateTime: event.end_time, timeZone: 'America/New_York' },
  }

  try {
    await cal.events.update({ calendarId: CALENDAR_ID, eventId: gcalEventId, requestBody: gcalEvent })
  } catch (err) {
    console.error('GCal update error:', err)
  }
}

// Delete a GCal event
export async function deleteGCalEvent(gcalEventId: string): Promise<void> {
  const cal = getCalendarClient()
  try {
    await cal.events.delete({ calendarId: CALENDAR_ID, eventId: gcalEventId })
  } catch (err) {
    console.error('GCal delete error:', err)
  }
}
