// Ported and adapted from legacy Apps Script app (Uploads.gs + LeadPerfection.gs)
import { google } from 'googleapis'

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  )
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return oauth2Client
}

export async function exportTabAsPdf(
  spreadsheetId: string,
  tabName: string,
  landscape: boolean
): Promise<Buffer> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  const sheet = meta.data.sheets?.find(s => s.properties?.title === tabName)
  if (!sheet) throw new Error(`Tab not found: ${tabName}`)
  const gid = sheet.properties?.sheetId

  const tokenRes = await auth.getAccessToken()
  const token = tokenRes.token
  if (!token) throw new Error('Failed to get OAuth token for PDF export')

  const params = new URLSearchParams({
    format: 'pdf',
    gid: String(gid),
    portrait: landscape ? 'false' : 'true',
    fitw: 'true',
    sheetnames: 'false',
    printtitle: 'false',
    pagenumbers: 'false',
    gridlines: 'false',
    fzr: 'false',
    size: 'letter',
  })

  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?${params}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    throw new Error(`PDF export failed for tab "${tabName}": HTTP ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

export async function readProjectTotals(spreadsheetId: string) {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Project Totals!O5:O10',
  })

  const v = result.data.values || []
  return {
    total_windows:  parseInt(v[0]?.[0]) || 0,
    total_doors:    parseInt(v[1]?.[0]) || 0,
    bay_windows:    parseInt(v[2]?.[0]) || 0,
    bow_windows:    parseInt(v[3]?.[0]) || 0,
    total_openings: parseInt(v[4]?.[0]) || 0,
    total_units:    parseInt(v[5]?.[0]) || 0,
  }
}

export async function readWorkOrderRows(spreadsheetId: string): Promise<any[][]> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Work Order!A16:Z25',
  })

  return result.data.values || []
}
