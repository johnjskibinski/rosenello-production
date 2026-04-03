import { google } from 'googleapis'
import { supabase } from './supabase'

const BACKLOG_SHEET_ID = '1ewMEc8yDJCJlumagcsEirZV7asHkL5G9'
const BACKLOG_GID = 326493103

const INSTALLER_MAP: Record<string, string> = {
  'Jay W Needed':       'Jay W',
  'Siding/Manuel':      'Manuel',
  'Roofing/Johnny':     'Jeremiah Construction',
  'Chuck WITH MATT':    'Chuck and Matt',
  'Ricardo/STK':        'Richy or STK',
  'Chuck or Matt Solo': 'Chuck or Matt Solo',
  'Any Sub':            'Any Sub',
}

function mapInstaller(raw: string): string {
  if (!raw?.trim()) return ''
  const trimmed = raw.trim()
  return INSTALLER_MAP[trimmed] || trimmed
}

function parseGross(raw: string): number {
  if (!raw) return 0
  return parseFloat(raw.replace(/[$,]/g, '')) || 0
}

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  )
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return oauth2Client
}

export interface ImportResult {
  total: number
  matched: number
  unmatched: string[]
  upserted: number
  errors: string[]
}

export async function importFromBacklogSheet(): Promise<ImportResult> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  // Find the tab name by gid
  const meta = await sheets.spreadsheets.get({ spreadsheetId: BACKLOG_SHEET_ID })
  const tab = meta.data.sheets?.find(s => s.properties?.sheetId === BACKLOG_GID)
  if (!tab?.properties?.title) throw new Error(`Tab with gid ${BACKLOG_GID} not found`)
  const tabName = tab.properties.title

  // Read sheet data (skip header row)
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: BACKLOG_SHEET_ID,
    range: `${tabName}!A2:G200`,
  })

  const rows = (resp.data.values || []).filter(r => r[0]?.trim())

  // Pull all active jobs from Supabase
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('lp_job_id, customer_last, customer_first, gross_amount, lp_status, product')
    .not('lp_status', 'in', '("C","P","E","X","G","J","L")')
  if (error) throw error

  const result: ImportResult = {
    total: rows.length,
    matched: 0,
    unmatched: [],
    upserted: 0,
    errors: [],
  }

  for (const row of rows) {
    const lastName = (row[0] || '').trim()
    const grossRaw = (row[3] || '').trim()
    const first    = mapInstaller((row[4] || '').trim())
    const second   = mapInstaller((row[5] || '').trim())
    const notes    = (row[6] || '').trim()
    const gross    = parseGross(grossRaw)

    if (!lastName) continue

    // Match by last name
    const candidates = (jobs || []).filter(
      j => j.customer_last?.toLowerCase() === lastName.toLowerCase()
    )

    let match: any = null
    if (candidates.length === 1) {
      match = candidates[0]
    } else if (candidates.length > 1 && gross > 0) {
      // Tiebreak by gross amount — within $100
      match = candidates.find(j => Math.abs(parseFloat(j.gross_amount || 0) - gross) < 100)
    }

    if (!match) {
      result.unmatched.push(`${lastName} ($${gross})`)
      continue
    }

    result.matched++

    try {
      const { error: upsertErr } = await supabase
        .from('job_installer_suggestions')
        .upsert(
          {
            lp_job_id:     match.lp_job_id,
            first_choice:  first || null,
            second_choice: second || null,
            notes:         notes || null,
            updated_at:    new Date().toISOString(),
          },
          { onConflict: 'lp_job_id' }
        )
      if (upsertErr) throw upsertErr
      result.upserted++
    } catch (err: any) {
      result.errors.push(`${lastName}: ${err.message}`)
    }
  }

  return result
}
