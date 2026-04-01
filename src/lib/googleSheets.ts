import { google } from 'googleapis'

const TEMPLATE_SHEET_ID = '1WfdoSeTwr-nt-8OF6eBRs72YZ8kjQzEDf00xkmzH2Ws'
const DRIVE_FOLDER_ID = '1ZWQoi0_ZV2-K2UeuGXQUnYNouUTes3V2'

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  )
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  })
  return oauth2Client
}

export async function createMeasureSheet(job: any): Promise<string | null> {
  try {
    const auth = getAuth()
    const drive = google.drive({ version: 'v3', auth })
    const sheets = google.sheets({ version: 'v4', auth })

    const customerName = `${job.customer_first} ${job.customer_last}`
    const sheetTitle = `Measure - ${customerName} - ${job.contract_id || job.lp_job_id}`

    // Skip if sheet already exists
    const existing = await drive.files.list({
      q: `name='${sheetTitle}' and trashed=false`,
      fields: 'files(id, name)',
    })
    if (existing.data.files && existing.data.files.length > 0) {
      console.log(`Measure sheet already exists for job ${job.lp_job_id}`)
      return existing.data.files[0].id || null
    }

    // Copy the template into the Rosenello Measure Sheets folder
    const copy = await drive.files.copy({
      fileId: TEMPLATE_SHEET_ID,
      requestBody: {
        name: sheetTitle,
        parents: [DRIVE_FOLDER_ID],
      },
    })
    const newSheetId = copy.data.id!

    const d = job.raw_lp_data || {}
    const address = [d.address1, d.city, d.state, d.zip].filter(Boolean).join(', ')
    const humanJobId = d.contractid || job.contract_id || ''
    const numericJobId = job.lp_job_id
    const phone = d.phone1 || ''
    const gross = parseFloat(d.grossamount || job.gross_amount || 0)
    const balance = parseFloat(d.balancedue || job.balance_due || 0)

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: newSheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: 'Costing!C1', values: [[humanJobId]] },
          { range: 'Costing!C2', values: [[customerName]] },
          { range: 'Costing!C3', values: [[address]] },
          { range: 'Costing!C4', values: [[phone]] },
          { range: 'Costing!D5', values: [[gross]] },
          { range: 'Costing!G5', values: [[balance]] },
          { range: 'Costing!J1', values: [[numericJobId]] },
        ],
      },
    })

    console.log(`Created measure sheet for ${customerName}: https://docs.google.com/spreadsheets/d/${newSheetId}`)
    return newSheetId
  } catch (err: any) {
    console.error(`Failed to create measure sheet for job ${job.lp_job_id}:`, err?.message || err)
    return null
  }
}
