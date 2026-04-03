import { google } from 'googleapis'
import { supabase } from './supabase'

const STATUS_LABELS: Record<string, string> = {
  SN: 'Scope Needed',
  PU: 'Scope / Pickup Check',
  SS: 'Scope Scheduled',
  MR: 'Scope Complete / In Review',
  D:  'Waiting HOA Approval',
  '2': 'Materials Ordered',
  NS: 'Need to Schedule',
  S:  'Scheduled',
  '5': 'In Progress',
  T:  'Installed & Unpaid',
  SI: 'Need Subcontractor Invoice',
  B:  'Backlog',
  '1': 'Deposit Received',
  '3': 'Partially Installed',
  CM: 'Complete',
  U:  'Unworkable',
}

const SUGGESTIONS_SHEET_NAME = 'Rosenello Installer Suggestions'
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1ZWQoi0_ZV2-K2UeuGXQUnYNouUTes3V2'

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  )
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return oauth2Client
}

export async function pushSuggestionsToSheet(): Promise<{ url: string; rows: number }> {
  const auth = getAuth()
  const drive = google.drive({ version: 'v3', auth })
  const sheets = google.sheets({ version: 'v4', auth })

  const { data: suggestions, error: sErr } = await supabase
    .from('job_installer_suggestions')
    .select('*')
    .order('updated_at', { ascending: false })
  if (sErr) throw sErr

  const lpJobIds = (suggestions || []).map((s: any) => s.lp_job_id)
  const { data: jobs, error: jErr } = await supabase
    .from('jobs')
    .select('lp_job_id, customer_first, customer_last, city, state, lp_status, total_units, gross_amount, product')
    .in('lp_job_id', lpJobIds.length > 0 ? lpJobIds : [-1])
  if (jErr) throw jErr

  const jobMap = new Map((jobs || []).map((j: any) => [j.lp_job_id, j]))

  const headers = [
    'Last Name', 'First Name', 'City', 'State', 'Job Status',
    'Unit Count', 'Gross Amount', 'Job Type',
    'Installer 1 (Recommended)', 'Installer 2 (Backup)', 'Notes', 'LP Job ID'
  ]

  const rows = (suggestions || []).map((s: any) => {
    const job: any = jobMap.get(s.lp_job_id) || {}
    return [
      job.customer_last || '',
      job.customer_first || '',
      job.city || '',
      job.state || '',
      STATUS_LABELS[job.lp_status] || job.lp_status || '',
      job.total_units ?? 0,
      job.gross_amount ? Number(job.gross_amount).toFixed(2) : '0.00',
      job.product || '',
      s.first_choice || '',
      s.second_choice || '',
      s.notes || '',
      s.lp_job_id,
    ]
  })

  const existing = await drive.files.list({
    q: `name='${SUGGESTIONS_SHEET_NAME}' and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'`,
    fields: 'files(id, webViewLink)',
  })

  let spreadsheetId: string
  let url: string

  if (existing.data.files && existing.data.files.length > 0) {
    spreadsheetId = existing.data.files[0].id!
    url = existing.data.files[0].webViewLink!
  } else {
    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: SUGGESTIONS_SHEET_NAME },
        sheets: [{ properties: { title: 'Suggestions', sheetId: 0 } }]
      }
    })
    spreadsheetId = created.data.spreadsheetId!
    url = created.data.spreadsheetUrl!
    await drive.files.update({
      fileId: spreadsheetId,
      addParents: DRIVE_FOLDER_ID,
      removeParents: 'root',
      fields: 'id, parents',
    })
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'Suggestions!A:L',
  })

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Suggestions!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [headers, ...rows] }
  })

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: headers.length },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                backgroundColor: { red: 0.012, green: 0.416, blue: 0.263 },
              }
            },
            fields: 'userEnteredFormat(textFormat,backgroundColor)'
          }
        },
        {
          updateSheetProperties: {
            properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount'
          }
        },
        {
          setBasicFilter: {
            filter: {
              range: { sheetId: 0, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: headers.length }
            }
          }
        }
      ]
    }
  })

  return { url, rows: rows.length }
}
