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
export function normalizeTitle(rawTitle: string, job: any, installers?: string[]): string {
  if (!job) return rawTitle
  const last = job.customer_last || ''
  const first = job.customer_first || ''
  const prefix = installers && installers.length > 0 ? `(${installers.join(', ')}) ` : ''
  return `${prefix}${last}, ${first}`.trim()
}

// Extract installers from title like "(Jay W, Ricardo) Smith, John"
export function extractInstaller(title: string): string {
  const match = title.match(/^\(([^)]+)\)/)
  return match ? match[1] : ''
}

export function extractInstallers(title: string): string[] {
  const match = title.match(/^\(([^)]+)\)/)
  if (!match) return []
  return match[1].split(',').map(s => s.trim()).filter(Boolean)
}

// Job type words to strip from titles before matching
const JOB_TYPE_WORDS = /\b(siding|roofing|windows|window|doors|door|service|gutters|gutter|repair|install|measure|pickup|pick up|check|hoa|approval)\b/gi

// Extract last name from title like "(Jay W) Smith, John" or "Smith, John - 7 DHs" or "Smith siding"
export function extractLastName(title: string): string {
  // Strip installer prefix (Jay W)
  let stripped = title.replace(/^\([^)]+\)\s*/, '').trim()
  // Strip after dash (e.g. "Smith - 7 DHs")
  stripped = stripped.split(' - ')[0].trim()
  // Strip job type words
  stripped = stripped.replace(JOB_TYPE_WORDS, '').trim()
  // Take first word before comma or space
  return stripped.split(/[,\s]/)[0].trim()
}

// Build notes string for a job event
export function buildNotes(job: any, eventType: string): string {
  const lines: string[] = []
  if (job.raw_lp_data?.phone1) lines.push(`Phone: ${job.raw_lp_data.phone1}`)

  // Work order lines from work_order_rows column (array of arrays)
  const wo = job.work_order_rows
  if (Array.isArray(wo) && wo.length > 0) {
    wo.forEach((row: any) => {
      const text = Array.isArray(row) ? row[0] : (row.description || row.item || '')
      if (text && text.trim()) lines.push(text.trim())
    })
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

  // 1. Try address match — most reliable
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

  // 2. Last name match — strip job type words + installer prefix first
  const lastName = extractLastName(title)
  if (lastName && lastName.length > 2) {
    // Try exact match first
    const { data: exact } = await supabase
      .from('jobs')
      .select('*')
      .ilike('customer_last', lastName)
      .limit(5)
    if (exact && exact.length === 1) return exact[0]

    // If multiple hits, try to disambiguate with first name from title
    if (exact && exact.length > 1) {
      const stripped = title.replace(/^\([^)]+\)\s*/, '').replace(JOB_TYPE_WORDS, '').trim()
      const parts = stripped.split(/[,\s]+/)
      const firstName = parts.length > 1 ? parts[1].trim() : ''
      if (firstName) {
        const match = exact.find(j => j.customer_first?.toLowerCase().startsWith(firstName.toLowerCase()))
        if (match) return match
      }
      return exact[0]
    }
  }

  // 3. Try matching by street number only if address present but full match failed
  if (location) {
    const numMatch = location.match(/^(\d+)/)
    if (numMatch) {
      const num = numMatch[1]
      const lastName2 = extractLastName(title)
      if (lastName2.length > 2) {
        const { data } = await supabase
          .from('jobs')
          .select('*')
          .ilike('address', `${num} %`)
          .ilike('customer_last', `%${lastName2}%`)
          .limit(1)
        if (data && data.length > 0) return data[0]
      }
    }
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
        if (allDay && ev.id) {
          const date = startTime.slice(0, 10)
          const notes = ev.summary || ''
          const { data: existing } = await supabase
            .from('calendar_availability').select('gcal_event_ids').eq('date', date).single()
          const existingIds = existing?.gcal_event_ids || []
          const mergedIds = Array.from(new Set([...existingIds, ev.id]))
          await supabase.from('calendar_availability')
            .upsert({ date, notes, gcal_event_ids: mergedIds, updated_at: new Date().toISOString() }, { onConflict: 'date' })
        }
        continue
      }

      job = await matchEventToJob(ev)
      linked = !!job
      if (!linked) unlinked++

      const installerList = extractInstallers(ev.summary || '')
      const title = job ? normalizeTitle(ev.summary || '', job, installerList) : (ev.summary || '')

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
        installer: installerList[0] || '',
        installers: installerList,
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
    summary: (() => {
      const instList: string[] = event.installers?.length ? event.installers : (event.installer ? [event.installer] : [])
      const base = event.title?.replace(/^\([^)]+\)\s*/, '') || ''
      return instList.length > 0 ? `(${instList.join(', ')}) ${base}` : base
    })(),
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

  // All-day end date must be day after start for GCal
  if (event.all_day) {
    const d = new Date(event.start_time.slice(0, 10) + 'T00:00:00')
    d.setDate(d.getDate() + 1)
    gcalEvent.end = { date: d.toISOString().slice(0, 10) }
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
